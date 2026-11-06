export * from "./api.ts";
export { discover, isPluginId, parseManifest, satisfiesCaret, type BrokenSource, type LayerRoot } from "./manifest.ts";
export { resolve, type Plan, type PlanEntry, type PlanState, type ResolveOptions } from "./resolve.ts";
export { PluginHost, planPlugins, type HostOptions, type PluginInfo, type PluginState } from "./host.ts";
export { pluginsCommand } from "./rescue.ts";
export {
  addPlugin,
  installDir,
  readRecords,
  removePlugin,
  updatePlugins,
  type AddOptions,
  type Added,
  type InstallRecord,
  type UpdateOptions,
  type UpdateResult,
  type UpdateStatus,
} from "./install.ts";
export { parseSource, type PluginSourceSpec, type SourceKind } from "./source.ts";
export { treeHash } from "./hash.ts";
export { CORE_PLUGIN_ID, NO_APPROVAL_REASON, Sessions } from "./session.ts";
export { pluginConfig, readConfigFile, type ConfigFile } from "./config.ts";
export { FAULT_LIMIT } from "./state.ts";
