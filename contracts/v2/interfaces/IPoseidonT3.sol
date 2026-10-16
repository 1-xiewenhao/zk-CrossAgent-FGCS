// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IPoseidonT3 {
    function poseidon(uint256[2] calldata input) external pure returns (uint256);
}
