// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// A unidirectional payment channel for tab, trustless on chain. The payer deposits
// once; the voucher signer (the agent's EVM key) signs cumulative EIP-712 vouchers
// off chain, one per call; the payee closes once with the highest voucher and is
// paid that much, the payer gets the rest. If the payee never closes, the payer
// starts a unilateral close and, after the dispute window, takes the deposit back;
// during the window the payee can still close with its best voucher, so it is
// never cheated of what it was signed. Vouchers are cumulative, so a voucher can
// never be spent twice: closing pays the amount once and deletes the channel.
//
// Not wired into the tab gateway in 3.0, which holds channel deposits in a
// gateway-held escrow address instead; see SPEC.md section 5.6 and DEPLOY.md.
//
// A channel id is used once, ever: closing deletes the channel but not the record
// that the id existed, so a voucher signed for an old channel can never pay on a
// new one opened with the same payer and salt.
//
// Unsupported tokens: fee-on-transfer and rebasing tokens break the deposit
// accounting (the contract records the amount asked for, not the amount
// received). A token that can blacklist addresses can block close and finalize
// for a blacklisted payer or payee, since both transfers happen in one call.

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract TabChannel {
    struct Channel {
        address payer; // funds the deposit, gets the remainder back
        address payee; // the seller, the only one who can close with a voucher
        address signer; // signs vouchers: the agent's EVM address
        address token;
        uint128 deposit;
        uint64 expiresAt; // after this the payer may start a close without waiting for the payee
        uint32 disputeWindow; // seconds the payee has to answer a unilateral close
        uint64 closeStartedAt; // 0 while open
    }

    mapping(bytes32 => Channel) public channels;
    mapping(bytes32 => bool) public used; // never cleared: an id is good for one channel only

    bytes32 public constant VOUCHER_TYPEHASH = keccak256("Voucher(bytes32 channel,uint256 amount)");
    bytes32 public immutable DOMAIN_SEPARATOR;

    event Opened(bytes32 indexed id, address indexed payer, address indexed payee, address signer, address token, uint256 deposit, uint64 expiresAt, uint32 disputeWindow);
    event ToppedUp(bytes32 indexed id, uint256 deposit);
    event CloseStarted(bytes32 indexed id, uint64 at);
    event Closed(bytes32 indexed id, uint256 paid, uint256 refunded);

    constructor() {
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("TabChannel")), keccak256(bytes("1")), block.chainid, address(this)
        ));
    }

    function channelId(address payer, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(payer, salt));
    }

    function open(bytes32 salt, address payee, address signer, address token, uint128 deposit, uint64 expiresAt, uint32 disputeWindow) external returns (bytes32 id) {
        id = channelId(msg.sender, salt);
        require(!used[id], "channel id used");
        used[id] = true;
        require(payee != address(0) && signer != address(0) && token != address(0), "zero address");
        require(deposit > 0, "empty deposit");
        require(expiresAt > block.timestamp, "already expired");
        require(disputeWindow >= 60 && disputeWindow <= 30 days, "dispute window out of range");
        channels[id] = Channel(msg.sender, payee, signer, token, deposit, expiresAt, disputeWindow, 0);
        require(IERC20(token).transferFrom(msg.sender, address(this), deposit), "deposit failed");
        emit Opened(id, msg.sender, payee, signer, token, deposit, expiresAt, disputeWindow);
    }

    function topUp(bytes32 id, uint128 amount) external {
        Channel storage c = channels[id];
        require(c.payer != address(0), "no channel");
        require(c.closeStartedAt == 0, "closing");
        c.deposit += amount;
        require(IERC20(c.token).transferFrom(msg.sender, address(this), amount), "top up failed");
        emit ToppedUp(id, c.deposit);
    }

    function voucherDigest(bytes32 id, uint256 amount) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, keccak256(abi.encode(VOUCHER_TYPEHASH, id, amount))));
    }

    /// The payee closes with the highest voucher it holds, at any time, also during a dispute window.
    function close(bytes32 id, uint256 amount, uint8 v, bytes32 r, bytes32 s) external {
        Channel memory c = channels[id];
        require(c.payer != address(0), "no channel");
        require(msg.sender == c.payee, "only the payee closes with a voucher");
        require(amount <= c.deposit, "voucher above deposit");
        // low s only, so one voucher has one signature
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "high s");
        address got = ecrecover(voucherDigest(id, amount), v, r, s);
        require(got != address(0) && got == c.signer, "bad voucher signature");
        delete channels[id];
        if (amount > 0) require(IERC20(c.token).transfer(c.payee, amount), "payout failed");
        if (c.deposit - amount > 0) require(IERC20(c.token).transfer(c.payer, c.deposit - amount), "refund failed");
        emit Closed(id, amount, c.deposit - amount);
    }

    /// The payer (or its signer) asks to close without the payee: after the dispute window it gets the deposit back.
    function startClose(bytes32 id) external {
        Channel storage c = channels[id];
        require(c.payer != address(0), "no channel");
        require(msg.sender == c.payer || msg.sender == c.signer, "only the payer or its signer");
        require(c.closeStartedAt == 0, "already closing");
        c.closeStartedAt = uint64(block.timestamp);
        emit CloseStarted(id, c.closeStartedAt);
    }

    /// Anyone, once a started close has waited out the dispute window, or once the channel is past expiry plus the window.
    function finalize(bytes32 id) external {
        Channel memory c = channels[id];
        require(c.payer != address(0), "no channel");
        bool waited = c.closeStartedAt != 0 && block.timestamp >= uint256(c.closeStartedAt) + c.disputeWindow;
        bool lapsed = block.timestamp >= uint256(c.expiresAt) + c.disputeWindow;
        require(waited || lapsed, "dispute window still open");
        delete channels[id];
        require(IERC20(c.token).transfer(c.payer, c.deposit), "refund failed");
        emit Closed(id, 0, c.deposit);
    }
}
