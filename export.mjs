import pkg from 'pdfjs-dist/legacy/build/pdf.js';
// https://stackoverflow.com/questions/12380841/generate-png-image-using-node-js
import Jimp from 'jimp';
import assert from 'assert';

// Named import for OPS worked in 2.5.207, but works no more in 2.9.359.
const { getDocument, OPS } = pkg;

// Copy from `src/shared/util.js` as it is not exported.
// https://github.com/mozilla/pdf.js/blob/2823beba6991f0cf26380291c7c54b522c0242f4/src/shared/util.js#L46-L50
const ImageKind = {
  GRAYSCALE_1BPP: 1,
  RGB_24BPP: 2,
  RGBA_32BPP: 3,
};

const setPngFromImg = (png, img) => {
  let bpp;

  if (img.kind === ImageKind.RGB_24BPP) {
    bpp = 3;
  } else if (img.kind === ImageKind.RGBA_32BPP) {
    bpp = 4;
  } else {
    throw new Error(`Could not handle GRAYSCALE_1BPP ${img.kind}`)
  }

  for (let i = 0; i < img.width * img.height; i++) {
    const x = i % img.width;
    const y = i / img.width | 0;
    const j = i * bpp;

    assert(x < img.width);
    assert(y < img.height);
    assert(j < img.data.length);

    png.setPixelColor(
      Jimp.rgbaToInt(
        img.data[j],
        img.data[j + 1],
        img.data[j + 2],
        bpp === 3 ? 255 : img.data[j + 3],
      ),
      x,
      y,
    );
  }
};

assert(process.argv.length >= 4, 'Usage: node export.mjs source.pdf pageNumber');

const pdfUrl = process.argv[2];
const pageNumber = Number(process.argv[3]);

const doc = await getDocument({
  url: pdfUrl,
}).promise;

const page = await doc.getPage(pageNumber);

// https://stackoverflow.com/questions/18680261/extract-images-from-pdf-file-with-javascript
const operators = await page.getOperatorList();
const opsIndex = Object.fromEntries(Object.entries(OPS).map(e => e.reverse()));

console.log(`fns on page: ${operators.fnArray.map(n => `${opsIndex[n]} (${n})`).join(', ')}`);
console.log(operators);
console.debug(`working on paintImageXObject (${OPS.paintImageXObject}) fns`);

const images = [];

for (var i = 0; i < operators.fnArray.length; i++) {
  // https://kresy24.pl/wp-content/uploads/2013/01/Magazyn_Polski_1-2013.pdf
  // page 18 has no paintJpegXObject, but two paintImageXObject, so we work
  // only with this operation.
  if (operators.fnArray[i] === OPS.paintImageXObject) {
    const args = operators.argsArray[i];
    const [objectName] = args;
    const img = await page.objs.get(objectName);

    console.debug(`got ${objectName} obj: ${img.width} x ${img.height}`);

    // image data is at https://github.com/mozilla/pdf.js/blob/2823beba6991f0cf26380291c7c54b522c0242f4/src/core/image.js
    // .data has decoded per-pixel values as needed for ImageData accepted by canvas.
    // https://developer.mozilla.org/en-US/docs/Web/API/ImageData
    // https://github.com/mozilla/pdf.js/issues/10498
    // https://github.com/mozilla/pdf.js/blob/d49b2f6cc2b7ed86da22d55ddb1af0b8a5fe5a1e/examples/image_decoders/jpeg_viewer.js

    // Output to png is usually done via Canvas [1], which requires DOM. On Node is could be done using standalone encoder, e.g. https://www.npmjs.com/package/pngjs
    // checkout less popular https://github.com/image-js/fast-png
    // [1]: https://stackoverflow.com/questions/13416800/how-to-generate-an-image-from-imagedata-in-javascript

    const png = new Jimp(img.width, img.height);

    setPngFromImg(png, img);

    images.push({ objectName, img, png });
  }
}

// https://www.zobodat.at/pdf/Z-dtsch-Geol-Ges_22_0903-0917.pdf
// pages 16, 18 and 20 require composition to get final image.
if (process.argv.some(v => v === '--composite')) {
  const compositeFilename = `composite_${pageNumber}.png`;

  console.log(`writting composite image into ${compositeFilename}`);

  const smallerImage = images[0];
  const largerImage = images[1];
  const { width: maxWidth, height: maxHeight } = largerImage.png.bitmap;
  const composite = smallerImage.png.scaleToFit(maxWidth, maxHeight).composite(largerImage.png, 0, 0);

  await composite.writeAsync(compositeFilename);
} else {
  console.log(`writting images: ${images.map(i => i.objectName).join(', ')}`);
  await Promise.all(images.map(({ objectName, png }) => png.writeAsync(objectName + '.png')));
}
