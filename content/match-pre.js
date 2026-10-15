// Runs just before TensorFlow.js. Its bundled async helper stores itself in a global named regeneratorRuntime and,
// when that global does not exist yet, falls back to building it from a string, which an extension may not do.
// With the global already there, the plain assignment works.
if (!('regeneratorRuntime' in self)) self.regeneratorRuntime = undefined;
