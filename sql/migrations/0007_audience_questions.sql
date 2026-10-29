-- Questions about who may use a product (src/audience.ts, src/questions.ts kind 'audience'): when research and the
-- architecture review disagree about the audience, or nobody in the developer-profile data fits it (subject
-- 'persona_supply'), the customer is asked instead of personas being picked from people who could never use the product.
--
-- 0006 declared the kind CHECK inline, so its name is generated: find it by its definition and replace it with a named
-- one. Idempotent; the table's RLS policy and grants (0006) are unchanged.
DO $mig$
DECLARE c TEXT;
BEGIN
  FOR c IN SELECT con.conname FROM pg_constraint con
            WHERE con.conrelid = 'product_questions'::regclass AND con.contype = 'c'
              AND pg_get_constraintdef(con.oid) ILIKE '%kind%' LOOP
    EXECUTE format('ALTER TABLE product_questions DROP CONSTRAINT %I', c);
  END LOOP;
  ALTER TABLE product_questions ADD CONSTRAINT product_questions_kind_check CHECK (kind IN ('competitor_relation', 'audience'));
END $mig$;
