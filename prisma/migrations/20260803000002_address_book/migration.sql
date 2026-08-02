-- Turns the Address table into something a customer can actually use.
--
-- The model has been in the schema since the beginning and nothing has ever
-- read or written it, so there are no rows to migrate. The new columns are
-- nullable anyway: required ones would make this a migration that can fail on
-- deploy, and a failed migration stops the service booting. The write path
-- requires both.
ALTER TABLE "Address" ADD COLUMN "name" TEXT;
ALTER TABLE "Address" ADD COLUMN "phone" TEXT;

-- The shop ships within India only. A US default on an Indian address book is
-- the kind of thing that goes unnoticed until it is printed on a label.
ALTER TABLE "Address" ALTER COLUMN "country" SET DEFAULT 'India';

-- Every read is "the addresses belonging to this customer".
CREATE INDEX "Address_userId_idx" ON "Address"("userId");
