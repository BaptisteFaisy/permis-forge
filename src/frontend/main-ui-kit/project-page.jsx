/**
 * Project page "Agents" (spec §15.3) — the chained journal with its filters,
 * the activity statistics, the agent profiles with their trust capital, the
 * 30-day observation report, the chain verification screen (spec §15.6) and the
 * simulation console (spec §15.4), which answers exactly like the MCP tool.
 */
import React, { useState } from 'react';
import ForgeReconciler, {
  Button,
  Heading,
  Inline,
  SectionMessage,
  Stack,
  Text,
  Textfield,
} from '@forge/react';
import { invoke } from '@forge/bridge';
import {
  Count,
  DecisionLozenge,
  Empty,
  ErrorNote,
  Field,
  LevelLozenge,
  Loading,
  Section,
  useResolver,
} from './common';

function SimulationConsole() {
  const [target, setTarget] = useState('db/migrations/001_init.sql');
  const [actionClass, setActionClass] = useState('A-02');
  const [issueKey, setIssueKey] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const simulate = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = { target, actionClass: actionClass || undefined, issueKey: issueKey || undefined };
      const answer = await invoke('simulationConsole', payload);
      setResult(answer);
      if (answer && answer.error) setError(String(answer.error));
    } catch (err) {
      setError(err && err.message ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack space="space.100">
      <Textfield label="Target (path, table or command)" value={target} onChange={(event) => setTarget(event.target.value)} />
      <Textfield label="Announced class (optional)" value={actionClass} onChange={(event) => setActionClass(event.target.value)} />
      <Textfield label="Issue key (optional)" value={issueKey} onChange={(event) => setIssueKey(event.target.value)} />
      <Button appearance="primary" isDisabled={busy} onClick={simulate}>
        Simulate
      </Button>
      {error ? <ErrorNote message={error} /> : null}
      {result && !result.error ? (
        <Stack space="space.050">
          <Inline space="space.100" alignBlock="center">
            <DecisionLozenge decision={result.decision} />
            <LevelLozenge level={result.level} label={result.levelName} />
            {result.wouldBlock ? <Text>would block</Text> : null}
          </Inline>
          <Field
            label="Classified as"
            value={`${result.classification.actionClass}${
              result.classification.reclassified ? ' (reclassified)' : ''
            }`}
          />
          {result.classification.reason ? <Field label="Why" value={result.classification.reason} /> : null}
          <Field label="Rule" value={result.resolution && result.resolution.rule ? result.resolution.rule.id : 'class default'} />
          <Field label="Reason" value={result.reason} />
          <Field label="Next step" value={result.guidance} />
          <Text>{result.resolution && result.resolution.observeOnly ? 'Observe mode: nothing is blocked.' : ''}</Text>
        </Stack>
      ) : null}
    </Stack>
  );
}

function ChainVerification({ projectId }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const verify = async () => {
    setBusy(true);
    const answer = await invoke('verifyLedger', { projectId });
    setResult(answer);
    setBusy(false);
  };

  return (
    <Stack space="space.100">
      <Button isDisabled={busy} onClick={verify}>
        Verify the journal chain
      </Button>
      {result ? (
        result.valid || result.ok ? (
          <SectionMessage appearance="success" title={`Chain intact — ${result.checked} entries verified`} />
        ) : (
          <SectionMessage
            appearance="danger"
            title={`Chain broken at seq ${result.firstBreak ? result.firstBreak.seq : '?'}`}
          >
            <Text>{`expected ${result.firstBreak ? result.firstBreak.expectedHash : '?'} — got ${
              result.firstBreak ? result.firstBreak.actualHash : '?'
            }`}</Text>
          </SectionMessage>
        )
      ) : null}
    </Stack>
  );
}

const App = () => {
  const { data, error, loading, reload } = useResolver('projectPage');
  const [page, setPage] = useState(1);

  if (loading) return <Loading />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Empty text="No data." />;

  const stats = data.stats || {};
  const observation = data.observation || {};

  return (
    <Stack space="space.300">
      <Heading level="h200">{`${data.title} — ${data.projectId}`}</Heading>

      <Section title="Activity">
        <Inline space="space.200">
          <Count label="journal entries" value={stats.totalEntries || 0} />
          <Count label="decisions" value={stats.decisions || 0} />
          <Count label="active permits" value={stats.activePermits || 0} />
          <Count label="pending requests" value={stats.pendingRequests || 0} />
          <Count label="agent profiles" value={stats.agentProfiles || 0} />
        </Inline>
      </Section>

      <Section title="Simulation console">
        <SimulationConsole />
      </Section>

      <Section title="Journal">
        {data.entries.length === 0 ? (
          <Empty text="No entry yet." />
        ) : (
          <Stack space="space.050">
            {data.entries.map((entry) => (
              <Inline key={String(entry.seq)} space="space.100">
                <Text>{`#${entry.seq}`}</Text>
                <Text>{entry.at}</Text>
                <Text>{entry.kind}</Text>
                {entry.actionClass ? <Text>{entry.actionClass}</Text> : null}
                {entry.decision ? <DecisionLozenge decision={entry.decision} /> : null}
                <Text>{entry.target || ''}</Text>
                <Text>{entry.permitId || ''}</Text>
              </Inline>
            ))}
          </Stack>
        )}
        <Inline space="space.100" alignBlock="center">
          <Button isDisabled={page <= 1} onClick={() => setPage(Math.max(1, page - 1))}>
            Previous
          </Button>
          <Text>{`page ${data.page} / ${data.totalPages}`}</Text>
          <Button isDisabled={data.page >= data.totalPages} onClick={() => setPage(page + 1)}>
            Next
          </Button>
          <Button appearance="subtle" onClick={reload}>
            Refresh
          </Button>
        </Inline>
      </Section>

      <Section title="Journal integrity">
        <ChainVerification projectId={data.projectId} />
      </Section>

      <Section title="Agent profiles and trust capital">
        {data.agents.length === 0 ? (
          <Empty text="No agent profile registered yet." />
        ) : (
          <Stack space="space.050">
            {data.agents.map((agent) => (
              <Inline key={agent.id} space="space.100">
                <Text weight="bold">{agent.name || agent.id}</Text>
                <Text>{agent.client}</Text>
                <Count label="capital" value={agent.capital} />
                <Text>{agent.trustStatus}</Text>
              </Inline>
            ))}
          </Stack>
        )}
      </Section>

      <Section title="Observation report (30 days)">
        <Field label="Decisions observed" value={String(observation.totalObserved || 0)} />
        <Field label="Would have been blocked" value={String(observation.wouldHaveBlocked || 0)} />
        {observation.byClass ? (
          <Field
            label="By class"
            value={Object.entries(observation.byClass)
              .map(([code, count]) => `${code}: ${count}`)
              .join(', ')}
          />
        ) : null}
      </Section>
    </Stack>
  );
};

ForgeReconciler.render(<App />);
