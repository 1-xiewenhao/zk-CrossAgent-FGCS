// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IPoseidonT7 {
    function poseidon(uint256[6] calldata input) external pure returns (uint256);
}
