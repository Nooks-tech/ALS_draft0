-- Each client opens a distinct partial_refund command adding one card component
-- against the SAME shared order/rail basis. The merchant + amounts come from the
-- fixture row so no external variables are needed.
\set k :client_id
SELECT public.open_reversal_command(
  f.merchant_id, 'pd-budget-race', 'partial_refund',
  'pd-key-' || :k, 'pd-fp-' || :k, 'system', NULL, 'test', 'pd-sha-' || :k,
  pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'rail', 'card', 'captured_basis_halala', f.captured_basis_halala,
    'basis_source', 'legacy_derived', 'evidence_sha256', 'aa'
  )),
  pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'rail', 'card', 'amount_halala', f.per_component_halala,
    'is_external', true, 'provider', 'moyasar'
  ))
)
FROM public.phase_d_concurrency_fixture AS f
WHERE f.singleton;
