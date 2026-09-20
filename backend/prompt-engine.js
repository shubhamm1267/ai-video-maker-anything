function cleanPrompt(prompt) {
  return String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildNegativePrompt() {
  return [
    'face morphing',
    'identity change',
    'character redesign',
    'duplicate people',
    'duplicate objects',
    'disappearing objects',
    'appearing objects',
    'object teleportation',
    'extra fingers',
    'missing fingers',
    'extra limbs',
    'missing limbs',
    'deformed hands',
    'deformed face',
    'warped anatomy',
    'melting objects',
    'geometry deformation',
    'texture flickering',
    'frame flickering',
    'temporal instability',
    'inconsistent clothing',
    'inconsistent hairstyle',
    'inconsistent lighting',
    'broken shadows',
    'impossible collisions',
    'objects passing through each other',
    'unnatural motion',
    'camera jumps',
    'sudden scene changes',
    'visual artifacts',
    'glitches',
    'bugs'
  ].join(', ');
}

function buildCharacterRules(hasReferenceImage = false) {
  if (hasReferenceImage) {
    return `
CHARACTER CONSISTENCY:
Use the provided reference image as the primary visual identity reference.
Preserve the same character throughout the entire video.

Maintain:
- facial identity
- face proportions
- hairstyle
- hair color
- skin tone
- body proportions
- clothing
- accessories
- distinctive visual features

Do not redesign, replace, age, de-age, morph, duplicate or transform the character.
The character must remain the same person from the first frame to the last frame.
`;
  }

  return `
CHARACTER CONSISTENCY:
Any character introduced in the scene must remain visually consistent.
Maintain stable face, hairstyle, clothing, body proportions and appearance.
Do not randomly redesign or replace characters.
`;
}

function buildPhysicsRules() {
  return `
PHYSICS AND MOTION:
Use physically plausible motion throughout the entire video.

Gravity must act continuously where applicable.
Objects must have continuous trajectories.
Acceleration and deceleration should be natural.
Momentum should be preserved.
Objects must not teleport.
Objects must not suddenly change size, shape or direction without a physical reason.
Objects must not pass through solid objects.
Collisions must produce physically plausible reactions.
Human movement must follow natural body mechanics.
Joints and limbs must move naturally.
`;
}

function buildTemporalRules() {
  return `
TEMPORAL CONSISTENCY:
Maintain strong frame-to-frame continuity.
Motion must be smooth and continuous.
Keep the environment stable.
Keep object identity stable.
Keep character identity stable.
Avoid sudden visual changes.
Avoid flickering.
Avoid geometry deformation.
Avoid texture popping.
Avoid random changes between frames.
`;
}

function buildCameraRules() {
  return `
CAMERA:
Use a stable cinematic camera unless camera movement is explicitly required.
Camera movement must be smooth and physically coherent.
Do not introduce unnecessary zooms, jumps, cuts or perspective changes.
`;
}

function buildVisualRules() {
  return `
VISUAL QUALITY:
Create a coherent, polished video.
Maintain consistent lighting, shadows, materials, colors and environment.
Keep all visible objects structurally stable.
Use realistic depth, scale and perspective.
Prioritize temporal consistency over unnecessary visual complexity.
`;
}

function compileVideoPrompt({
  prompt,
  hasReferenceImage = false,
  mode = 'high'
}) {
  const userPrompt = cleanPrompt(prompt);

  if (!userPrompt) {
    throw new Error('Prompt is required');
  }

  const qualityInstruction =
    mode === 'standard'
      ? `
QUALITY:
Generate a clean coherent video with natural motion.
`
      : `
QUALITY:
Prioritize temporal consistency, subject consistency, object consistency,
natural motion, realistic physics and clean frame-to-frame transitions.
`;

  const finalPrompt = `
VIDEO GENERATION INSTRUCTION

USER SCENE:
${userPrompt}

${buildCharacterRules(hasReferenceImage)}

${buildPhysicsRules()}

${buildTemporalRules()}

${buildCameraRules()}

${buildVisualRules()}

${qualityInstruction}

IMPORTANT:
The requested scene must remain coherent from beginning to end.
Do not introduce unrelated objects, people or scene changes.
Do not alter the identity of important subjects.
Do not create impossible physical interactions.
Do not create duplicate objects.
Do not make objects disappear or appear without cause.
`;

  return {
    prompt: finalPrompt.trim(),
    negativePrompt: buildNegativePrompt()
  };
}

function buildRetryPrompt(originalPrompt, attempt) {
  const retryRules = `
REGENERATION PASS ${attempt}

This is a correction pass.

Increase attention to:
- temporal consistency
- stable geometry
- character identity
- object identity
- natural anatomy
- physically plausible motion
- continuous trajectories
- stable lighting
- stable camera
- clean frame transitions

If an action is complex, simplify the motion while preserving the user's intended action.
Prefer physically plausible simple movement over visually complicated movement.
`;

  return `${originalPrompt}\n\n${retryRules}`;
}

module.exports = {
  compileVideoPrompt,
  buildRetryPrompt,
  buildNegativePrompt,
};