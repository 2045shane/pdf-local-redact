export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

/** Concatenate PDF matrices. `apply(multiply(a, b), p)` = apply(a, apply(b, p)). */
export function multiply(a, b) {
  const [a1, b1, c1, d1, e1, f1] = a;
  const [a2, b2, c2, d2, e2, f2] = b;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invert(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  return [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ];
}

export function isIdentity(m) {
  const id = [1, 0, 0, 1, 0, 0];
  return m.every((value, index) => Math.abs(value - id[index]) < 1e-6);
}

export function normalizeRect(rect) {
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  return {
    x: width < 0 ? x + width : x,
    y: height < 0 ? y + height : y,
    width: Math.abs(width),
    height: Math.abs(height),
  };
}

export function intersects(a, b, pad = 0.05) {
  return (
    a.x < b.x + b.width + pad &&
    a.x + a.width > b.x - pad &&
    a.y < b.y + b.height + pad &&
    a.y + a.height > b.y - pad
  );
}

export function bboxOfPoints(points) {
  if (!points.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function hitsAny(box, rects) {
  if (!box || box.width < 0 || box.height < 0) return false;
  return rects.some((rect) => intersects(box, rect));
}

/** Unit square (0,0)-(1,1) through CTM, as a page-space box. */
export function unitSquareBox(ctm) {
  return bboxOfPoints([
    apply(ctm, 0, 0),
    apply(ctm, 1, 0),
    apply(ctm, 1, 1),
    apply(ctm, 0, 1),
  ]);
}
