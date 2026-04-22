import type { CardPolygon } from "@/lib/crm-types";

export interface CardBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function polygonToBounds(polygon: CardPolygon): CardBounds {
  const xs = [
    polygon.topLeft.x,
    polygon.topRight.x,
    polygon.bottomRight.x,
    polygon.bottomLeft.x,
  ];
  const ys = [
    polygon.topLeft.y,
    polygon.topRight.y,
    polygon.bottomRight.y,
    polygon.bottomLeft.y,
  ];

  const minX = Math.max(0, Math.min(...xs));
  const minY = Math.max(0, Math.min(...ys));
  const maxX = Math.min(1, Math.max(...xs));
  const maxY = Math.min(1, Math.max(...ys));

  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
}

export function polygonArea(polygon: CardPolygon): number {
  const points = [
    polygon.topLeft,
    polygon.topRight,
    polygon.bottomRight,
    polygon.bottomLeft,
  ];

  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }

  return Math.abs(area / 2);
}

export function needsReviewForDetection(expectedCount: number | null, actualCount: number): boolean {
  if (!expectedCount || expectedCount <= 0) {
    return actualCount === 0;
  }

  return actualCount === 0 || actualCount < Math.max(1, expectedCount - 2);
}
