// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script, console} from "forge-std/Script.sol";
import {ExamRegistry} from "../src/ExamRegistry.sol";

/// @notice Deploys ExamRegistry with the board address from BOARD_ADDRESS.
contract Deploy is Script {
    function run() external returns (ExamRegistry registry) {
        address board = vm.envAddress("BOARD_ADDRESS");

        vm.startBroadcast();
        registry = new ExamRegistry(board);
        vm.stopBroadcast();

        console.log("ExamRegistry", address(registry));
        console.log("Board", board);
    }
}
