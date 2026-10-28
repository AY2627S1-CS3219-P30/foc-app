export type PagedOrders<T> = {
  items: T[];
  nextCursor: string | null;
  pagesLoaded: number;
};

export function mergeOrders<T extends { orderId: string }>(first: T[], later: T[]): T[] {
  const seen = new Set(first.map((order) => order.orderId));
  return [...first, ...later.filter((order) => !seen.has(order.orderId))];
}

export function refreshPage<T extends { orderId: string }>(
  current: PagedOrders<T> | null,
  first: { items: T[]; nextCursor: string | null },
): PagedOrders<T> {
  if (!current || current.pagesLoaded === 1) return { ...first, pagesLoaded: 1 };
  return {
    items: mergeOrders(first.items, current.items),
    nextCursor: current.pagesLoaded > 1 ? current.nextCursor : first.nextCursor,
    pagesLoaded: current.pagesLoaded,
  };
}

export function appendPage<T extends { orderId: string }>(
  current: PagedOrders<T>,
  next: { items: T[]; nextCursor: string | null },
): PagedOrders<T> {
  return {
    items: mergeOrders(current.items, next.items),
    nextCursor: next.nextCursor,
    pagesLoaded: current.pagesLoaded + 1,
  };
}
