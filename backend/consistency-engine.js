function buildConsistencyConfig({
  hasReferenceImage = false,
  lockCharacter = true,
  lockObjects = true,
}) {
  return {
    hasReferenceImage,
    lockCharacter,
    lockObjects,

    characterRules: lockCharacter
      ? [
          'stable facial identity',
          'stable hairstyle',
          'stable hair color',
          'stable skin tone',
          'stable clothing',
          'stable body proportions',
          'stable accessories',
        ]
      : [],

    objectRules: lockObjects
      ? [
          'stable object identity',
          'stable object shape',
          'stable object color',
          'stable object scale',
          'no duplicate objects',
          'no disappearing objects',
        ]
      : [],
  };
}

function getConsistencyPrompt(config) {
  const parts = [];

  if (config.lockCharacter) {
    parts.push(`
CHARACTER LOCK:
Keep important characters visually identical throughout the shot.
Preserve facial identity, hairstyle, clothing and body proportions.
`);
  }

  if (config.lockObjects) {
    parts.push(`
OBJECT LOCK:
Important objects must preserve their identity, shape, color and scale.
Do not duplicate, remove or randomly transform important objects.
`);
  }

  if (config.hasReferenceImage) {
    parts.push(`
REFERENCE IMAGE:
The uploaded reference image represents the identity and appearance
of the main subject. Preserve those visual characteristics throughout
the generated video.
`);
  }

  return parts.join('\n').trim();
}

module.exports = {
  buildConsistencyConfig,
  getConsistencyPrompt,
};