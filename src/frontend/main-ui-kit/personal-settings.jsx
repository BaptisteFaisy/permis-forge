/**
 * Personal settings (spec §15 / §16) — the personal hook token.
 *
 * The plaintext token is shown exactly once, at creation; the app stores only
 * its SHA-256 hash, so a leaked database cannot be replayed against the gate.
 * The screen repeats where to put the token and that it grants no right by
 * itself: it only identifies the pilot.
 */
import React, { useState } from 'react';
import ForgeReconciler, {
  Button,
  Code,
  Heading,
  Inline,
  SectionMessage,
  Stack,
  Text,
  Textfield,
} from '@forge/react';
import { Empty, ErrorNote, Field, Loading, Section, useMutation, useResolver } from './common';

const App = () => {
  const { data, error, loading, reload } = useResolver('personalSettings', { action: 'list' });
  const [label, setLabel] = useState('');
  const [issued, setIssued] = useState(null);
  const mutation = useMutation(reload);

  if (loading) return <Loading />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Empty text="No data." />;

  const generate = async () => {
    const result = await mutation.run('generateHookToken', { label: label.trim() || undefined });
    if (result && result.token) setIssued(result);
  };

  const tokens = data.tokens || [];

  return (
    <Stack space="space.300">
      <Heading level="h200">{data.title}</Heading>
      <Field label="Account" value={data.accountId} />

      <Section title="Generate a token">
        <Stack space="space.100">
          <Textfield
            label="Label (optional, e.g. the machine name)"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
          {mutation.error ? <ErrorNote message={mutation.error} /> : null}
          <Button appearance="primary" isDisabled={mutation.busy} onClick={generate}>
            Generate
          </Button>
        </Stack>
      </Section>

      {issued ? (
        <SectionMessage appearance="warning" title="Shown once — copy it now">
          <Stack space="space.100">
            <Code text={issued.token} />
            <Text>{issued.notice}</Text>
            <Text>{'Export it where the agent runs:  export PERMIS_AGENT_TOKEN="<token>"'}</Text>
            <Text>{'Optionally set the ticket:  export PERMIS_AGENT_ISSUE="PAY-42"'}</Text>
          </Stack>
        </SectionMessage>
      ) : null}

      <Section title="Your tokens">
        {tokens.length === 0 ? (
          <Empty text="No token yet." />
        ) : (
          <Stack space="space.050">
            {tokens.map((token) => (
              <Inline key={token.tokenHash} space="space.100">
                <Code text={`${token.tokenHash.slice(0, 12)}…`} />
                <Text>{token.label || 'unlabelled'}</Text>
                <Text>{`created ${token.createdAt}`}</Text>
                <Text>{token.lastUsedAt ? `last used ${token.lastUsedAt}` : 'never used'}</Text>
              </Inline>
            ))}
          </Stack>
        )}
      </Section>

      <Section title="What this token is">
        <Text>
          It identifies you as the pilot of an agent. It grants no right by itself: every action is
          still decided by the project policy, and an approval can never come from you if you are
          the pilot of the request.
        </Text>
        <Text>{data.notice}</Text>
      </Section>
    </Stack>
  );
};

ForgeReconciler.render(<App />);
