//! The connection's mailbox for scrollback answers: find, copy-mode motions,
//! selection reads, and the editor hand-off. It is kept apart from the modal
//! dialog slot so none of these overwrites or steals a dialog's response, and
//! it is replaced with the connection, so an answer can never reach a newer
//! one. Each feature keeps at most one request here at a time, so the slots
//! below are bounded by the number of features, not by user input.

use herdr_client::{
    ClientEvent,
    scrollback::{ScrollbackResponse, decode_response},
};
use std::collections::VecDeque;

/// More requests than any combination of features keeps outstanding.
const MAX_REQUESTS: usize = 8;

type Answer = herdr_client::Result<ScrollbackResponse>;

#[derive(Default)]
pub(crate) struct Inbox {
    pending: VecDeque<String>,
    answers: VecDeque<(String, Answer)>,
    /// Requests whose owner went away. Their answers are swallowed instead of
    /// reaching the window's status line as unexplained daemon errors.
    discarded: VecDeque<String>,
}

impl Inbox {
    /// Claims the events that answer a registered request and passes on the
    /// rest. Runs on the event reader, under the same lock `send` takes.
    pub(crate) fn apply(&mut self, event: ClientEvent) -> Option<ClientEvent> {
        if matches!(event, ClientEvent::Disconnected { .. }) {
            for request in std::mem::take(&mut self.pending) {
                self.answer(request, Err(herdr_client::Error::Disconnected));
            }
            self.discarded.clear();
            return Some(event);
        }
        let request = match &event {
            ClientEvent::Response { request_id, .. } => request_id,
            ClientEvent::CommandRejected {
                request_id: Some(request_id),
                ..
            } => request_id,
            _ => return Some(event),
        };
        if let Some(index) = self.discarded.iter().position(|id| id == request) {
            self.discarded.remove(index);
            return None;
        }
        let Some(index) = self.pending.iter().position(|id| id == request) else {
            return Some(event);
        };
        let Some(request) = self.pending.remove(index) else {
            return Some(event);
        };
        let answer = match event {
            ClientEvent::Response { response, .. } => decode_response(&response),
            ClientEvent::CommandRejected { reason, .. } => Err(reason),
            _ => return None,
        };
        self.answer(request, answer);
        None
    }

    fn answer(&mut self, request: String, answer: Answer) {
        if self.answers.len() == MAX_REQUESTS {
            self.answers.pop_front();
        }
        self.answers.push_back((request, answer));
    }

    /// Registers the request `send` queues while holding the mailbox, so even
    /// an immediate rejection finds it pending.
    pub(crate) fn send(
        &mut self,
        send: impl FnOnce() -> herdr_client::Result<String>,
    ) -> herdr_client::Result<String> {
        if self.pending.len() >= MAX_REQUESTS {
            return Err(herdr_client::Error::Full);
        }
        let request = send()?;
        self.pending.push_back(request.clone());
        Ok(request)
    }

    /// The answer to `request`, once; `None` while it is outstanding.
    pub(crate) fn take(&mut self, request: &str) -> Option<Answer> {
        let index = self.answers.iter().position(|(id, _)| id == request)?;
        self.answers.remove(index).map(|(_, answer)| answer)
    }

    /// Gives up on `request`: an answer already here is dropped, and one
    /// still on its way is swallowed when it comes.
    pub(crate) fn discard(&mut self, request: &str) {
        if self.take(request).is_some() {
            return;
        }
        if let Some(index) = self.pending.iter().position(|id| id == request)
            && let Some(request) = self.pending.remove(index)
        {
            if self.discarded.len() == MAX_REQUESTS {
                self.discarded.pop_front();
            }
            self.discarded.push_back(request);
        }
    }
}

pub(crate) use herdr_pane_view::scrollback::reveal_offset;

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use serde_json::json;

    fn response(id: &str) -> ClientEvent {
        ClientEvent::Response {
            request_id: id.into(),
            response: json!({"id": id, "result": {"type": "ok"}}),
        }
    }

    #[test]
    fn answers_are_claimed_by_request_and_taken_once() {
        let mut inbox = Inbox::default();
        inbox.send(|| Ok("a".into())).unwrap();
        inbox.send(|| Ok("b".into())).unwrap();
        assert!(inbox.apply(response("other")).is_some(), "not ours");
        assert!(inbox.apply(response("b")).is_none());
        assert!(inbox.take("a").is_none(), "still outstanding");
        assert_eq!(inbox.take("b").unwrap().unwrap(), ScrollbackResponse::Ok {});
        assert!(inbox.take("b").is_none(), "an answer moves out once");
        let rejected = ClientEvent::CommandRejected {
            request_id: Some("a".into()),
            reason: herdr_client::Error::Full,
        };
        assert!(inbox.apply(rejected).is_none());
        assert!(matches!(
            inbox.take("a"),
            Some(Err(herdr_client::Error::Full))
        ));
        assert!(inbox.apply(response("a")).is_some(), "no longer pending");
    }

    #[test]
    fn a_disconnect_fails_everything_outstanding() {
        let mut inbox = Inbox::default();
        inbox.send(|| Ok("a".into())).unwrap();
        inbox.send(|| Ok("b".into())).unwrap();
        let disconnect = ClientEvent::Disconnected {
            reason: "gone".into(),
        };
        assert!(
            inbox.apply(disconnect).is_some(),
            "the window still sees it"
        );
        for id in ["a", "b"] {
            assert!(matches!(
                inbox.take(id),
                Some(Err(herdr_client::Error::Disconnected))
            ));
        }
    }

    #[test]
    fn discarded_requests_are_swallowed_and_registration_is_bounded() {
        let mut inbox = Inbox::default();
        inbox.send(|| Ok("a".into())).unwrap();
        inbox.discard("a");
        assert!(inbox.apply(response("a")).is_none(), "swallowed");
        assert!(inbox.take("a").is_none());
        assert!(inbox.apply(response("a")).is_some(), "only once");

        assert!(
            inbox
                .send(|| Err(herdr_client::Error::Disconnected))
                .is_err()
        );
        for index in 0..MAX_REQUESTS {
            inbox.send(|| Ok(format!("r{index}"))).unwrap();
        }
        assert!(matches!(
            inbox.send(|| Ok("over".into())),
            Err(herdr_client::Error::Full)
        ));
    }
}
