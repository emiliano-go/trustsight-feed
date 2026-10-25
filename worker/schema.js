//: The schema this Worker expects.  Keep in step with the migration that sets
//: `meta.schema`; a mismatch is a deployment fault, not a reason to serve.
export const EXPECTED_SCHEMA = '12'
