/**
 * Global page (spec §15.5) — the organisation view: the policy floor that no
 * project may soften, the global emergency stop, and the state of every class.
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
import { Empty, ErrorNote, Field, LevelLozenge, Loading, Section, useMutation, useResolver } from './common';

function OrgKillSwitch({ data, onChanged }) {
  const [reason, setReason] = useState('');
  const mutation = useMutation(onChanged);
  const active = Boolean(data.killSwitch && data.killSwitch.active);

  const toggle = () =>
    mutation.run('toggleProjectKillSwitch', {
      scope: 'org',
      activate: !active,
      reason: reason.trim(),
    });

  return (
    <Stack space="space.100">
      {active ? <SectionMessage appearance="danger" title={data.killSwitchLabels.banner} /> : null}
      <Field label="State" value={active ? `ON — by ${data.killSwitch.by || '?'}` : 'off'} />
      <Textfield
        label="Reason (mandatory, both ways)"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      {mutation.error ? <ErrorNote message={mutation.error} /> : null}
      <Button
        appearance={active ? 'default' : 'danger'}
        isDisabled={mutation.busy || reason.trim().length === 0}
        onClick={toggle}
      >
        {active ? data.killSwitchLabels.lift : data.killSwitchLabels.activate}
      </Button>
    </Stack>
  );
}

const App = () => {
  const { data, error, loading, reload } = useResolver('globalPage');

  if (loading) return <Loading />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Empty text="No data." />;

  const status = data.status || {};
  const classes = status.classes || [];

  return (
    <Stack space="space.300">
      <Heading level="h200">{data.title}</Heading>

      <Section title="Organisation emergency stop">
        <OrgKillSwitch data={data} onChanged={reload} />
      </Section>

      <Section title="Policy floor">
        <Text>A project may harden a class, never soften it below this floor.</Text>
        {data.orgRules.length === 0 ? (
          <Empty text="No organisation rule: every project decides alone." />
        ) : (
          <Stack space="space.050">
            {data.orgRules.map((rule) => (
              <Inline key={rule.id} space="space.100" alignBlock="center">
                <LevelLozenge level={rule.level} label={rule.levelName} />
                <Text weight="bold">{rule.actionClass}</Text>
                <Text>{rule.className}</Text>
                <Text>{rule.mode}</Text>
              </Inline>
            ))}
          </Stack>
        )}
      </Section>

      <Section title="Classes and floors">
        <Stack space="space.050">
          {classes.map((entry) => (
            <Inline key={entry.code} space="space.100" alignBlock="center">
              <Text weight="bold">{entry.code}</Text>
              <Text>{entry.name}</Text>
              <LevelLozenge level={entry.defaultLevel} />
              <Text>{entry.orgFloor === undefined ? 'no org floor' : `org floor: N${entry.orgFloor}`}</Text>
              {entry.locked ? <Text>locked</Text> : null}
            </Inline>
          ))}
        </Stack>
      </Section>

      <Section title="Summary">
        <Field label="Organisation rules" value={String(status.orgRuleCount || 0)} />
        <Field label="Emergency stop" value={status.emergencyStopActive ? 'active' : 'inactive'} />
      </Section>
    </Stack>
  );
};

ForgeReconciler.render(<App />);
