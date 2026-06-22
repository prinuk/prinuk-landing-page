ALTER TABLE "products" ADD COLUMN "vat_exempt" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "vat_exempt" boolean DEFAULT true NOT NULL;