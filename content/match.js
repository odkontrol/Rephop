/*
 * RepHop's photo matcher, put into a Reddit tab only when you ask which item a gallery photo shows.
 * It describes each picture with a small image model (MobileNet V2, bundled, run here on your computer)
 * plus the colours of what is in the middle of the picture, and says how alike two pictures are.
 * Pictures arrive as bytes from RepHop's background, so nothing is sent anywhere from here.
 */
(() => {
  if (self.RepMatch) return;
  const U = self.RepUtil;
  let model = null;

  async function ready() {
    if (!model) {
      await tf.ready();
      model = await tf.loadGraphModel(chrome.runtime.getURL('lib/vendor/mobilenet/model.json'));
    }
    return model;
  }

  function canvasOf(bitmap, size) {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    c.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0, size, size);
    return c;
  }

  /** A picture's description, from its bytes (base64) and type: { e: model vector, c: colours }, or null. */
  async function features(b64, type) {
    let bitmap;
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      bitmap = await createImageBitmap(new Blob([bytes], { type: type || 'image/jpeg' }));
    } catch (_) {
      return null;
    }
    const m = await ready();
    const big = canvasOf(bitmap, 224);
    const v = tf.tidy(() => m.predict(tf.browser.fromPixels(big).toFloat().div(255).expandDims(0))).dataSync();
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    const e = Float32Array.from(v, (x) => x / n);
    const small = canvasOf(bitmap, U.PIC);
    const c = U.imageFeatures(small.getContext('2d').getImageData(0, 0, U.PIC, U.PIC).data, U.PIC, U.PIC);
    if (bitmap.close) bitmap.close();
    return { e, c };
  }

  /** How alike two described pictures are, 0 to 1: mostly what the thing is, a little its colours. */
  function similarity(a, b) {
    if (!a || !b) return null;
    let d = 0;
    for (let i = 0; i < a.e.length; i++) d += a.e[i] * b.e[i];
    return 0.75 * Math.max(0, d) + 0.25 * U.imageSimilarity(a.c, b.c);
  }

  self.RepMatch = { features, similarity, ready };
})();
