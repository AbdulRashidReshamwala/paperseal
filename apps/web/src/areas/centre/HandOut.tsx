import { Button, Check, PrimaryAction, Row, Rows, Stage } from '@paperseal/ui';

import { copiesProblem, MAX_ROOMS, totalCopies, type HandOut as HandOutState, type RoomStatus } from './rooms';

export const DEMO_LABEL = 'Demo: nothing is sent to any room';

const STATUS_WORDS: Record<RoomStatus, string> = {
  'not-sent': 'Not sent',
  sending: 'Sending',
  sent: 'Marked as sent (demo)',
};

function StatusCheck({ status }: { status: RoomStatus }) {
  const shape = status === 'sent' ? 'pass' : status === 'sending' ? 'pending' : 'not-checked';
  return <Check status={shape}>{STATUS_WORDS[status]}</Check>;
}

/**
 * Step after "The paper is open". The delivery is a demonstration: it changes what this page shows and sends nothing,
 * so no wording here may say a room has the paper.
 */
export function HandOutStage({ handOut, onPrint }: { handOut: HandOutState; onPrint: () => void }) {
  const { rooms } = handOut;
  const total = totalCopies(rooms);
  return (
    <Stage
      title="Hand out the paper"
      lede="Set how many copies each room needs, then send the paper to the rooms."
      action={
        <PrimaryAction
          status={handOut.sending ? 'busy' : handOut.allSent ? 'done' : 'idle'}
          busyLabel="Sending to the rooms"
          doneLabel="Sent to all rooms (demo)"
          disabled={!handOut.canSend && !handOut.sending && !handOut.allSent}
          onClick={handOut.send}
        >
          Send to the rooms
        </PrimaryAction>
      }
      next="Print the copies as usual. Nothing on this page reaches a room yet."
    >
      <p className="handout-demo" role="note">
        {DEMO_LABEL}
      </p>
      <div className="handout-rooms">
        <Rows>
          {rooms.map((room) => {
            const problem = copiesProblem(room.copies);
            return (
              <Row key={room.id} label={room.name}>
                <span className="handout-room">
                  <label className="handout-copies">
                    <span>Copies</span>
                    <input
                      className="ps-input"
                      inputMode="numeric"
                      value={room.copies}
                      aria-label={`Copies for ${room.name}`}
                      aria-invalid={problem ? true : undefined}
                      disabled={handOut.sending}
                      onChange={(event) => {
                        handOut.setCopies(room.id, event.target.value);
                      }}
                    />
                  </label>
                  {problem ? <span className="ps-field-error">{problem}</span> : <StatusCheck status={room.status} />}
                </span>
              </Row>
            );
          })}
        </Rows>
      </div>
      <p className="handout-total">
        {String(rooms.length)} {rooms.length === 1 ? 'room' : 'rooms'}, {String(total)} {total === 1 ? 'copy' : 'copies'} in all
      </p>
      <div className="handout-more">
        <Button onClick={handOut.addRoom} disabled={rooms.length >= MAX_ROOMS || handOut.sending}>
          Add a room
        </Button>
        <Button onClick={onPrint}>Print the paper</Button>
      </div>
    </Stage>
  );
}
