ALTER TABLE "orders" ADD COLUMN "sale_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_sale_name_idx" ON "orders" USING btree ("sale_name");