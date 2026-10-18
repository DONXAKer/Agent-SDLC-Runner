import type { StageId } from '@sdlc-runner/shared';
import type { ToolName } from '@sdlc-runner/shared';

/** Keep v2 artifact writes in the runtime; expose only the human-question tool on ask. */
export function preparationTools(
  tools: readonly ToolName[],
  stage: StageId,
  preparationV2: boolean,
  compactFillRoute: boolean,
): readonly ToolName[] {
  if (preparationV2 && (stage === 'intent' || stage === 'explore' || stage === 'plan')) {
    // Structured executors call the model without tools, then send their assembled artifact
    // through the ordinary write gate. Keep those runtime writes authorized without
    // exposing writer tools in the model prompt (BuildPrompt handles that separately).
    return tools.filter((tool) => tool === 'Write' || tool === 'Edit');
  }
  if (preparationV2 && stage === 'ask') {
    // The ask stage records answers through AskHuman; document editing is runtime-owned.
    return tools.filter((tool) => tool === 'Read' || tool === 'AskHuman' || tool === 'FinalizeArtifact');
  }
  const fillFieldOn = compactFillRoute;
  const base = fillFieldOn ? tools : tools.filter((tool) => tool !== 'FillField');
  return base;
}
