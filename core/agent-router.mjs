// Level 2 Task 6: thin convenience wrapper re-exporting the capability
// router. The implementation lives in core/capabilities.mjs to keep all
// capability logic in one file.

export {
  BUILTIN_CAPABILITIES,
  CapabilityError,
  DEFAULT_ROUTER_WEIGHTS,
  agentsForCapability,
  createCapability,
  deriveRouterMetrics,
  listCapabilities,
  rankAgents,
  selectAgent,
} from './capabilities.mjs';
