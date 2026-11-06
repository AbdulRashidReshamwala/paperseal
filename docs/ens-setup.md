# ENS Setup

How to give an exam an ENS name, so anyone can check it in the verifier by typing `jee-main-2026.<your-name>.eth`. The rules are in `spec/api.md`, "Exam Names", and why it helps is in the [README](../README.md#exam-names).

Everything here uses the **board wallet**: the address passed as `BOARD_ADDRESS` when `ExamRegistry` was deployed. The check fails if the name belongs to any other wallet.

This guide uses Sepolia, where anyone can register a look-alike name, so it is a demo of how the check works. A real board uses a mainnet name.

## 1. Register the board's name, once

1. Open [sepolia.app.ens.domains](https://sepolia.app.ens.domains) and connect the board wallet, with the wallet on Sepolia.
2. Search for a name, for example `paperseal-mumbai`, and register it. This takes two transactions about a minute apart.
   On Sepolia the registrar charges in **Circle's Sepolia USDC** (`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`), not ETH: about 8 USDC for a year. Get it free at [faucet.circle.com](https://faucet.circle.com) before you start, and keep a little Sepolia ETH for gas. The ENS test USDC and DAI listed in the ENS docs are refused by the registrar.
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

With `cast`, never pass a string that ends in `.eth` as a `string` argument, because `cast` replaces it with the address it resolves to. Encode it with `cast calldata "setName(string)" <name>.eth` and send that with `--data`.

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

## 4. Names for key holders and centres

Optional. The board can invite a key holder or a centre under an ENS name by typing it in "Invite people". A person with no ENS name can be invited under a plain name instead. Setters never have one.

- **A key holder uses their own name.** After they register, their Register page shows one value. They add a text record named `paperseal.passkey` to their own name with that value, using the ENS app on Sepolia. The board app then shows "Name confirmed". Until then it shows the key holder as waiting, and the board can choose to go ahead with the name marked unconfirmed.
- **A centre uses a name the board issues,** such as `north-1.centres.paperseal-mumbai.eth`. It needs no record. The board can change such a name, so the verifier shows it as a label only, and it proves nothing about independence.

Both the board app and the verifier read these names on Sepolia through their own RPC, on chain only. The board app uses `VITE_RPC_URL`, and the verifier uses the RPC under "Check it yourself". A name that can't be read shows as not confirmed and never fails the exam.
