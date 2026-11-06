# ENS Setup

How to give an exam an ENS name, so anyone can check it in the verifier by typing `jee-main-2026.<your-name>.eth`. The rules are in `spec/api.md`, "Exam Names", and why it helps is in the [README](../README.md#exam-names).

Everything here uses the **board wallet**: the address passed as `BOARD_ADDRESS` when `ExamRegistry` was deployed. The check fails if the name belongs to any other wallet.

This guide uses Sepolia, where anyone can register a look-alike name, so it is a demo of how the check works. A real board uses a mainnet name.

## 1. Register the board's name, once

1. Open [sepolia.app.ens.domains](https://sepolia.app.ens.domains) and connect the board wallet, with the wallet on Sepolia.
2. Search for a name, for example `paperseal-mumbai`, and register it. This takes two transactions about a minute apart.
3. Set it as the wallet's **primary name**. This is the reverse record the verifier reads to learn the board's name.
4. Open the name's records and check its **ETH address** is the board wallet. The verifier checks the name both ways.

## 2. Name each exam

The exam's name must be a valid ENS label, such as `jee-main-2026`: lowercase letters, digits and hyphens, with no spaces or dots. The board app refuses anything else when you create the exam, because a different spelling would hash to a different exam ID.

After publishing the exam, open the board app's status step. It lists the exact records to set.

With ENS v2, which the Sepolia ENS app runs, there is no subname to create. Your name has its own resolver, and that resolver can hold records for any name under it, such as `jee-main-2026.paperseal-mumbai.eth`. You write those records by name, and every write is one transaction from the board wallet.

| Record | Value |
| --- | --- |
| ETH address | The `ExamRegistry` address |
| Text `paperseal.tee` | The TEE URL, for example `https://tee.example.org` |
| Text `paperseal.storage` | The storage URL, for example `https://storage.googleapis.com/<bucket>` |
| Text `paperseal.bucket` | The storage bucket the TEE was started with |

The ENS app has no screen for this, so use `cast`, with the board keystore from the main setup:

1. Find your name's resolver:
   ```bash
   node -e 'const {createPublicClient,http}=require("viem");const {sepolia}=require("viem/chains");createPublicClient({chain:sepolia,transport:http("https://ethereum-sepolia-rpc.publicnode.com")}).getEnsResolver({name:"paperseal-mumbai.eth"}).then(console.log)'
   ```
   Run it from `packages/chain`, where viem is installed.
2. DNS-encode the exam's full name, also from `packages/chain`:
   ```bash
   node -e 'const {packetToBytes}=require("viem/ens");const {toHex}=require("viem");console.log(toHex(packetToBytes("jee-main-2026.paperseal-mumbai.eth")))'
   ```
3. Set the ETH address. `60` is ETH's coin type:
   ```bash
   cast send <resolver> "setAddress(bytes,uint256,bytes)" <encoded name> 60 <ExamRegistry address> --account paperseal-board --password-file ~/.paperseal/board-keystore-password --rpc-url https://ethereum-sepolia-rpc.publicnode.com
   ```
4. Set each text record you have, the same way:
   ```bash
   cast send <resolver> "setText(bytes,string,string)" <encoded name> paperseal.tee https://tee.example.org --account paperseal-board --password-file ~/.paperseal/board-keystore-password --rpc-url https://ethereum-sepolia-rpc.publicnode.com
   ```

If a public RPC times out, check with `cast nonce <board address> --block pending` whether the transaction went out before you send it again.

The three text records only tell the verifier where to look. A wrong value makes the later checks fail, it can't make them pass. Leave one out and the verifier uses the viewer's own settings under "Check it yourself" for it.

## 3. Check it

Open the verifier, type the full name into the exam box, or open `<verifier>/#/name/jee-main-2026.paperseal-mumbai.eth`. The first step, **Name**, should pass, and the page then runs the usual checks. If it fails, the step says which check failed:

| Failure | Usual cause |
| --- | --- |
| Not a valid name | The name isn't a normalised ENS name, for example it has uppercase letters or spaces, or the exam part isn't a valid exam name |
| No exam record | The exam name's ETH address is unset, or its code isn't `ExamRegistry`'s, or its records need an offchain gateway |
| Not the board’s name | The board wallet's primary name isn't the parent name, or isn't set |
| Not confirmed by the board | The parent name's ETH address isn't the board wallet |
| Can't read the name | The RPC URL under "Check it yourself" is down or isn't Sepolia |
