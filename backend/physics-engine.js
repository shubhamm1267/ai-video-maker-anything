function buildPhysicsPrompt() {
  return `
PHYSICAL SIMULATION RULES:

1. Gravity must behave naturally.
2. Objects must follow continuous trajectories.
3. Velocity changes must be smooth.
4. Momentum should be preserved.
5. Solid objects must not pass through each other.
6. Collisions must create plausible reactions.
7. Objects must maintain consistent size and geometry.
8. No teleportation.
9. No impossible acceleration.
10. No sudden unexplained direction changes.
11. Human limbs must move using natural joint mechanics.
12. Feet should interact naturally with the ground.
13. Hands should interact naturally with held objects.
14. Shadows should remain consistent with light direction.
15. Perspective and object scale must remain coherent.
16. Water, smoke, cloth and particles should move continuously rather
    than flicker or randomly change structure.
`;
}

function getPhysicsPreset(type = 'general') {
  const presets = {
    general: `
Use realistic physical behavior and smooth natural motion.
`,

    human: `
Use realistic human biomechanics.
Maintain natural balance, joint movement, walking mechanics,
hand movement and body momentum.
`,

    object: `
Maintain stable object geometry, scale and material behavior.
Objects must interact naturally with the environment.
`,

    projectile: `
Use realistic projectile motion.
Maintain continuous velocity and gravity-driven trajectory.
`,

    fluid: `
Use continuous fluid motion.
Avoid sudden shape changes, flickering and disconnected fluid structures.
`,
  };

  return presets[type] || presets.general;
}

module.exports = {
  buildPhysicsPrompt,
  getPhysicsPreset,
};