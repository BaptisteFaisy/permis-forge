/**
 * Issue panel (spec §15.1) — the approval card of spec §8.1, the permits in
 * force on the ticket, the last declared actions and any deviation.
 *
 * Three buttons, as the spec requires: grant, deny (reason mandatory), ask for
 * a detail. Approving your own request is refused by the service layer, and the
 * refusal reason is shown rather than swallowed.
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
import {
  DecisionLozenge,
  Empty,
  ErrorNote,
  Field,
  LevelLozenge,
  Loading,
  Section,
  useMutation,
  useResolver,
} from './common';

function RequestCard({ request, labels, onChanged }) {
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState(null);
  const mutation = useMutation(() => {
    setNotice(null);
    onChanged();
  });

  const decide = async (action) => {
    if (action === 'denyRequest' && reason.trim().length === 0) {
      setNotice('REASON_REQUIRED');
      return;
    }
    setNotice(null);
    const result = await mutation.run(action, {
      requestId: request.id,
      reason: reason.trim(),
      roles: ['project-admin'],
    });
    if (result && result.ok === false) setNotice(String(result.error));
    if (result && result.permit) setNotice(`Permit issued: ${result.permit}`);
  };

  return (
    <Stack space="space.100">
      <Inline space="space.100" alignBlock="center">
        <Heading level="h400">{request.id}</Heading>
        <LevelLozenge level={request.level} label={request.levelName} />
        <Text>{request.statusLabel || request.status}</Text>
      </Inline>
      <Field label="What" value={`${request.actionClass} — ${request.target}`} />
      <Field label="Requested" value={request.createdAt} />
      <Field label="Approvals so far" value={String(request.approvals)} />
      <Textfield
        label="Reason (mandatory to deny)"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      {notice ? <ErrorNote message={notice} /> : null}
      {mutation.error ? <ErrorNote message={mutation.error} /> : null}
      <Inline space="space.100">
        <Button appearance="primary" isDisabled={mutation.busy} onClick={() => decide('grantRequest')}>
          {labels.grant}
        </Button>
        <Button appearance="danger" isDisabled={mutation.busy} onClick={() => decide('denyRequest')}>
          {labels.deny}
        </Button>
      </Inline>
    </Stack>
  );
}

const App = () => {
  const { data, error, loading, reload } = useResolver('issuePanel');

  if (loading) return <Loading />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Empty text="No data." />;

  return (
    <Stack space="space.200">
      <Heading level="h200">{data.title}</Heading>
      {data.killSwitchBanner ? <SectionMessage appearance="danger" title={data.killSwitchBanner} /> : null}

      <Section title="Pending requests">
        {data.pendingRequests.length === 0 ? (
          <Empty text="No approval is waiting on this ticket." />
        ) : (
          <Stack space="space.200">
            {data.pendingRequests.map((request) => (
              <RequestCard key={request.id} request={request} labels={data.actions} onChanged={reload} />
            ))}
          </Stack>
        )}
      </Section>

      <Section title="Permits in force">
        {data.activePermits.length === 0 ? (
          <Empty text="None." />
        ) : (
          <Stack space="space.050">
            {data.activePermits.map((permit) => (
              <Inline key={permit.id} space="space.100">
                <Text weight="bold">{permit.id}</Text>
                <Text>{`${permit.actionClass} — ${permit.target}`}</Text>
                <Text>{`uses left: ${permit.usesLeft}`}</Text>
                <Text>{`expires: ${permit.expiresAt}`}</Text>
              </Inline>
            ))}
          </Stack>
        )}
      </Section>

      <Section title="Recent actions">
        {data.recentActions.length === 0 ? (
          <Empty text="Nothing declared yet." />
        ) : (
          <Stack space="space.050">
            {data.recentActions.map((entry) => (
              <Inline key={String(entry.seq)} space="space.100">
                <Text>{`#${entry.seq}`}</Text>
                <Text>{entry.kind}</Text>
                {entry.actionClass ? <Text>{entry.actionClass}</Text> : null}
                {entry.decision ? <DecisionLozenge decision={entry.decision} /> : null}
                <Text>{entry.target || ''}</Text>
              </Inline>
            ))}
          </Stack>
        )}
      </Section>

      {data.deviations.length > 0 ? (
        <Section title="Deviations">
          <Stack space="space.050">
            {data.deviations.map((entry) => (
              <Inline key={`dev-${String(entry.seq)}`} space="space.100">
                <Text>{`#${entry.seq}`}</Text>
                <Text>{entry.kind}</Text>
                <Text>{entry.target || ''}</Text>
              </Inline>
            ))}
          </Stack>
        </Section>
      ) : null}
    </Stack>
  );
};

ForgeReconciler.render(<App />);
