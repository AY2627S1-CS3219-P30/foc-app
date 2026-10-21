"use client";

import { use } from "react";
import { OrderDetail } from "./OrderDetail";

export default function RequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <OrderDetail orderId={id} />;
}
