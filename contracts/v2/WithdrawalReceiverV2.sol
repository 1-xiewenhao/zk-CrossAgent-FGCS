// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
interface IWithdrawalEscrow {
    function withdraw(uint256 amount, address payable recipient) external;
}
contract WithdrawalReceiverV2 {
    IWithdrawalEscrow public escrow;
    bool public rejectPayment;
    bool public tryReentry;
    bool public reentrySucceeded;
    function configure(address target, bool reject, bool reenter) external {
        escrow = IWithdrawalEscrow(target);
        rejectPayment = reject;
        tryReentry = reenter;
    }
    function take(uint256 amount) external { escrow.withdraw(amount, payable(address(this))); }
    receive() external payable {
        require(!rejectPayment, "receiver rejects");
        if (tryReentry) {
            (reentrySucceeded,) = address(escrow).call(
                abi.encodeCall(IWithdrawalEscrow.withdraw, (uint256(1), payable(address(this))))
            );
        }
    }
}
