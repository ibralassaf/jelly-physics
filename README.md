# Jelly

Real-time gelatin simulation in the browser, in SI units, with no dependencies.

Run it by double-clicking `start.cmd`, or with `npm start` and then opening http://localhost:5173.
`npm test` runs the physics checks headless.

**Controls:** click to poke, drag to pull, drag the background to orbit, scroll to zoom,
Space to bump the table, R to reset. The slider sets the gel's shear modulus from 6 kPa to 300 Pa.

## Physics (`src/sim.js`)

- Stable Neo-Hookean elasticity on about 6,000 tets, with constraints from Macklin & Mueller 2021
  solved as a coupled 2x2 per tet, so the rest pose has no stress.
- XPBD with small steps at 960 Hz, symmetric Gauss-Seidel.
- Objective Kelvin-Voigt shear viscosity at 2 Pa s, from published gelatin fits.
- A compliant whole-body volume constraint for near-incompressibility.
- Plate contact with Coulomb friction, plus adhesion that can peel and re-form.

## Rendering (`src/render.js`)

Refraction through both surfaces at n = 1.34, Beer-Lambert absorption, Fresnel reflection, one
internal bounce, forward scattering, and energy-conserving caustics on the plate. The smooth display
mesh follows the simulation through moving least squares, so the tet cage never shows in highlights.

## Known limits

- No self-collision: a fold pressed hard into itself can interpenetrate.
- The gel can't tear; the grab force is capped instead.
- Bulk stiffness per tet is far below real gelatin (about 2 GPa). Volume is held by the global
  constraint, so local compression is softer than reality.
- Absorption colours and the scattering term are chosen by eye, not measured.
- Damping is partly numerical. Measured zeta is 0.03-0.09, higher than the roughly 0.01 the viscosity
  alone predicts, and it hasn't been compared with a measured jelly ring-down.
