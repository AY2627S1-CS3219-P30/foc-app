-- Errands already picked up or delivered get their deadlines from the D1 periods (2 hours to
-- deliver, 24 hours to confirm): a migration cannot read DELIVERY_PERIOD_MS or AUTO_CONFIRM_MS.
UPDATE orders
   SET non_delivery_report_at = picked_up_at + interval '2 hours'
 WHERE status = 'PICKED_UP'
   AND non_delivery_report_at IS NULL;
--> statement-breakpoint
UPDATE orders
   SET auto_confirm_at = delivered_at + interval '24 hours'
 WHERE status = 'DELIVERED'
   AND auto_confirm_at IS NULL;
