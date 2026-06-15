CREATE TYPE "public"."fulfillment" AS ENUM('משלוח', 'איסוף עצמי');--> statement-breakpoint
CREATE TYPE "public"."item_mode" AS ENUM('unit', 'kg');--> statement-breakpoint
CREATE TYPE "public"."item_pick_status" AS ENUM('נאסף', 'חסר');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('חדש', 'בליקוט', 'נאסף', 'נאסף חלקית', 'נשלח', 'נמסר');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'credit');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('none', 'authorized', 'captured', 'partially_captured', 'failed', 'refunded', 'voided');--> statement-breakpoint
CREATE TYPE "public"."product_state" AS ENUM('active', 'oos', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('pending', 'success', 'failed');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('authorize', 'capture', 'void', 'refund');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text DEFAULT '' NOT NULL,
	"action" text NOT NULL,
	"order_id" uuid,
	"entity" text,
	"entity_id" text,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"full_name" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"provider_customer_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid,
	"product_name" text NOT NULL,
	"department" text DEFAULT '' NOT NULL,
	"mode" "item_mode" DEFAULT 'unit' NOT NULL,
	"quantity" numeric(10, 3) NOT NULL,
	"order_unit" text DEFAULT '' NOT NULL,
	"unit_price_agorot" integer DEFAULT 0 NOT NULL,
	"price_unit" text DEFAULT '' NOT NULL,
	"line_total_agorot" integer,
	"estimated_weight_kg" numeric(7, 3),
	"estimated_weight_per_unit_kg" numeric(7, 3),
	"is_estimated_price_total" boolean DEFAULT false NOT NULL,
	"is_estimated_weight_total" boolean DEFAULT false NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"pick_status" "item_pick_status",
	"actual_weight_kg" numeric(7, 3),
	"actual_line_total_agorot" integer,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"customer_id" uuid,
	"full_name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"fulfillment" "fulfillment" NOT NULL,
	"neighborhood" text DEFAULT '' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"floor" text DEFAULT '' NOT NULL,
	"apartment" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"status" "order_status" DEFAULT 'חדש' NOT NULL,
	"estimated_total_agorot" integer DEFAULT 0 NOT NULL,
	"delivery_fee_agorot" integer DEFAULT 0 NOT NULL,
	"grand_total_agorot" integer DEFAULT 0 NOT NULL,
	"unpriced_item_count" integer DEFAULT 0 NOT NULL,
	"actual_total_agorot" integer,
	"edit_token" text NOT NULL,
	"collected_by" text DEFAULT '' NOT NULL,
	"picked_at" timestamp with time zone,
	"customer_email_status" text DEFAULT '' NOT NULL,
	"customer_email_error" text DEFAULT '' NOT NULL,
	"business_email_status" text DEFAULT '' NOT NULL,
	"business_email_error" text DEFAULT '' NOT NULL,
	"telegram_status" text DEFAULT '' NOT NULL,
	"telegram_error" text DEFAULT '' NOT NULL,
	"payment_method" "payment_method",
	"payment_status" "payment_status" DEFAULT 'none' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" text DEFAULT '' NOT NULL,
	"method" "payment_method" NOT NULL,
	"status" "payment_status" DEFAULT 'none' NOT NULL,
	"currency" text DEFAULT 'ILS' NOT NULL,
	"authorized_amount_agorot" integer,
	"captured_amount_agorot" integer,
	"provider_customer_ref" text,
	"provider_payment_ref" text,
	"invoice_ref" text,
	"invoice_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"department" text DEFAULT 'אחר' NOT NULL,
	"unit" text DEFAULT 'יחידות' NOT NULL,
	"price_unit" text DEFAULT 'יחידות' NOT NULL,
	"price_agorot" integer DEFAULT 0 NOT NULL,
	"state" "product_state" DEFAULT 'active' NOT NULL,
	"weight_per_unit_kg" numeric(7, 3),
	"image_url" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"order_id" uuid,
	"type" "transaction_type" NOT NULL,
	"status" "transaction_status" DEFAULT 'pending' NOT NULL,
	"amount_agorot" integer,
	"idempotency_key" text,
	"provider_ref" text,
	"error_message" text DEFAULT '' NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_order_id_idx" ON "audit_log" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customers_phone_unique_idx" ON "customers" USING btree ("phone");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_order_id_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_order_code_unique_idx" ON "orders" USING btree ("order_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_created_at_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_phone_idx" ON "orders" USING btree ("phone");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_order_id_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_name_idx" ON "products" USING btree ("name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_state_idx" ON "products" USING btree ("state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_payment_id_idx" ON "transactions" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_order_id_idx" ON "transactions" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "transactions_idempotency_key_unique_idx" ON "transactions" USING btree ("idempotency_key");