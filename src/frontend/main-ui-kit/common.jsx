/**
 * Shared front-end helpers for the Jira screens (UI Kit 2).
 *
 * The screens are deliberately thin: every label, level name and status is
 * already localised by the resolvers (spec §19), so the front-end only lays
 * data out and wires buttons to resolver keys. All decision logic stays in
 * src/core and src/ui, which are typed and unit-tested.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Heading, Inline, Lozenge, Spinner, Stack, Text } from '@forge/react';
import { invoke } from '@forge/bridge';

/** Call one resolver key, with loading and error state, plus a reload. */
export function useResolver(key, payload = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    invoke(key, payload)
      .then((result) => {
        if (!active) return;
        setData(result);
        setError(null);
      })
      .catch((err) => {
        if (active) setError(err && err.message ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // The payload is built inline by each screen: nonce drives the refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, loading, reload };
}

/** Invoke a mutation, surface a refusal, then refresh the screen. */
export function useMutation(onDone) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const run = useCallback(
    async (key, payload) => {
      setBusy(true);
      setError(null);
      try {
        const result = await invoke(key, payload);
        if (result && result.ok === false) {
          setError(String(result.error || 'REFUSED'));
          return result;
        }
        onDone();
        return result;
      } catch (err) {
        setError(err && err.message ? err.message : String(err));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [onDone],
  );

  return { run, busy, error };
}

export const Loading = () => (
  <Inline alignBlock="center" space="space.100">
    <Spinner size="xsmall" />
    <Text>Loading…</Text>
  </Inline>
);

export const ErrorNote = ({ message }) => (
  <Stack space="space.050">
    <Text>{String(message)}</Text>
  </Stack>
);

/** Autonomy level as a coloured lozenge: N0/N1 red, N2/N3 amber, N4/N5 green. */
export const LevelLozenge = ({ level, label }) => {
  const appearance = level <= 1 ? 'removed' : level <= 3 ? 'moved' : 'success';
  return <Lozenge appearance={appearance}>{label || `N${level}`}</Lozenge>;
};

/** Decision of an enforcement point, as a lozenge. */
export const DecisionLozenge = ({ decision }) => {
  const appearance = decision === 'allow' ? 'success' : decision === 'ask' ? 'moved' : 'removed';
  return <Lozenge appearance={appearance}>{String(decision)}</Lozenge>;
};

export const Count = ({ label, value }) => (
  <Inline space="space.050" alignBlock="center">
    <Badge>{value}</Badge>
    <Text>{label}</Text>
  </Inline>
);

export const Section = ({ title, children }) => (
  <Stack space="space.100">
    <Heading level="h300">{title}</Heading>
    {children}
  </Stack>
);

/** One labelled line, used for the approval card fields. */
export const Field = ({ label, value }) => (
  <Inline space="space.100">
    <Text weight="bold">{label}</Text>
    <Text>{value === undefined || value === null || value === '' ? '—' : value}</Text>
  </Inline>
);

/** Empty-state line so a screen never looks broken when there is nothing yet. */
export const Empty = ({ text }) => <Text>{text}</Text>;
