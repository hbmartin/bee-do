export type Rect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type Point = { x: number; y: number };

export function containRect(
  containerWidth: number,
  containerHeight: number,
  imageWidth: number,
  imageHeight: number,
): Rect {
  if (containerWidth <= 0 || containerHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }

  const scale = Math.min(containerWidth / imageWidth, containerHeight / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return {
    left: (containerWidth - width) / 2,
    top: (containerHeight - height) / 2,
    width,
    height,
  };
}
export function normalizePoint(clientX: number, clientY: number, rect: Rect): Point | null {
  if (!rect.width || !rect.height) return null;
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

export function clampNormalizedPoint(clientX: number, clientY: number, rect: Rect): Point | null {
  if (!rect.width || !rect.height) return null;
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
  };
}

export function clampOffset(offset: number, itemSize: number, containerSize: number): number {
  if (![offset, itemSize, containerSize].every(Number.isFinite) || containerSize <= 0) return 0;
  return Math.min(Math.max(0, offset), Math.max(0, containerSize - Math.max(0, itemSize)));
}
