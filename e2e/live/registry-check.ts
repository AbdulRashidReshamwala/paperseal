import { checkRegistryCode, createExamRegistry } from '@paperseal/chain';

import { deployed } from './config';

/* `registry-check`: whether the deployed contract matches the pin in spec/registry.json. Read-only. */

export async function registryCheck(): Promise<void> {
  const registry = createExamRegistry({ address: deployed.registry, rpcUrl: deployed.rpcUrl });
  const result = checkRegistryCode(await registry.code());
  if (result.state === 'match') {
    console.log(`PASS  ${deployed.registry} matches the pin, for board ${result.board}`);
    return;
  }
  console.log(`FAIL  ${deployed.registry} ${result.state === 'none' ? 'has no code' : 'runs other code than the pin. Run make abi if the contract was redeployed.'}`);
  process.exitCode = 1;
}
