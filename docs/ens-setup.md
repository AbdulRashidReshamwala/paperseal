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

Publishing does this for you. Once the exam is saved, the board app asks the board wallet for one more confirmation, which writes every record below in one `multicall` on the resolver of the wallet's primary name. It reads the name back with the same checks the verifier runs, and shows the name and its link only if they all pass. The exam works without a name, so a declined or failed confirmation changes nothing else: the page says the name isn't set and offers Try again, and reopening the exam offers it too.

The app must be the one that published the exam in this browser, because `ExamRegistry` stores only the name's hash. In another browser, set the records by hand as below.

With ENS v2, which the Sepolia ENS app runs, there is no subname to create. Your name has its own resolver, and that resolver can hold records for any name under it, such as `jee-main-2026.paperseal-mumbai.eth`. The app takes the resolver from the chain and fills the values from its own settings: `VITE_REGISTRY_ADDRESS`, `VITE_TEE_URL`, `VITE_STORAGE_URL`, `VITE_TEE_STORAGE_BUCKET` and `VITE_ARKIV_WRITERS`. A setting left empty is not written.

| Record | Value |
| --- | --- |
| ETH address | The `ExamRegistry` address |
| Text `paperseal.tee` | The TEE URL, for example `https://tee.example.org` |
| Text `paperseal.storage` | The storage URL, for example `https://storage.googleapis.com/<bucket>` |
| Text `paperseal.bucket` | The storage bucket the TEE was started with |
| Text `paperseal.arkiv-writers` | Optional. The relay addresses that mirror the unlock to Arkiv, separated by commas (`spec/arkiv.md`, "Writers") |

To set them by hand, every write is one transaction from the board wallet. The ENS app has no screen for this, so use `cast`, with the board keystore from the main setup:

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

## 4. The directory of key holders and centres

Required for these roles. A key holder or a centre has one permanent ENS name that publishes their security key, and the board picks them from a directory. The parent name is `VITE_DIRECTORY_NAME` in the web app, `paperseal-demo.eth` by default. Whoever controls it is the directory owner. The people need no wallet.

Records for each person:

| Record | Value |
| --- | --- |
| ETH address | Any address, so the name exists. The script uses a burn address |
| Text `paperseal.passkey` | `passkey` from the key card |
| Text `paperseal.credential` | `credentialId` from the key card |

Record on the parent:

| Record | Value |
| --- | --- |
| Text `paperseal.directory` | A JSON array of names, at most 8,192 bytes, such as `["neutral-1.paperseal-demo.eth"]` |

The list is only a menu. Every listed name is checked by its own records.

### Add a person

1. They open `/enrol` on the app's domain, touch their security key, and send you the key card. Nothing on it is secret. Check it really came from them, because you are about to say this key is theirs.
2. Save the card as `card.json` and print the commands. This reads the resolver and sends nothing:
   ```bash
   node deploy/ens/records.mjs --name centre-1.paperseal-demo.eth --card card.json
   ```
3. Run each printed `cast send` with the wallet that controls the parent. The script passes names as encoded `--data`, because `cast` turns a string ending in `.eth` into an address.
4. Put every name in a JSON file, print the directory command, and run it:
   ```bash
   node deploy/ens/records.mjs --directory names.json
   ```

`--parent`, `--resolver`, `--account`, `--password-file` and `--rpc-url` change the defaults. A name is one transaction per record, so a full run of 3 key holders and 8 centres is 33 transactions and one for the directory.

### Replace a lost key

The person enrols a new key and sends the new card. Run step 2 and step 3 again for their name, which overwrites both records. The swap is public. A list already posted keeps the old key, so this helps from the next exam on.

### Keys and domains

A passkey belongs to one domain. If the app moves to another domain, everyone enrols again and every record is replaced.

### What this proves

The directory owner controls the parent, so they can write, change or take back any record under it, and a record says only that they put it there. For a centre that is acceptable, because the board approves centres anyway. For a neutral key holder the point is independence from the board, so a real exam needs each neutral to use a name they own, or a directory the board doesn't control. In the demo the board owns `paperseal-demo.eth` and issues the neutrals' records too, so the neutrals aren't independent there.

Both the board app and the verifier read these names on Sepolia through their own RPC, on chain only. The board app uses `VITE_RPC_URL`, and the verifier uses the RPC under "Check it yourself". On the board a name with no record stays off the list, and a name that can't be read offers "Try again". On the verifier a name that can't be read shows as not confirmed and never fails the exam.

What it costs, as best known and not checked against a live quote: on Sepolia only test ETH for gas, plus the one-off registration of `paperseal-demo.eth` itself (about 8 USDC for a year, see section 1) if it is not already registered. On mainnet, each record is a transaction at that day's gas price, and each neutral's own `.eth` name is its own yearly fee, which the neutral pays and keeps.

The ENS v2 behaviour here is the one section 2 relies on, and the commands have not been run against Sepolia for this change.
