import '../providers/index.js';
import { listProviderNames, listProviderRuntimeContractNames } from '../providers/provider-registry.js';

console.log(
  JSON.stringify({
    contracts: listProviderRuntimeContractNames().sort(),
    providers: listProviderNames().sort(),
  }),
);
