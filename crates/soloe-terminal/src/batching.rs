use std::time::{Duration, Instant};

pub const DEFAULT_BATCH_INTERVAL: Duration = Duration::from_millis(16);
pub const DEFAULT_MAX_BATCH_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputBatch {
    pub seq: u64,
    pub data: Vec<u8>,
}

/// Coalesces one PTY's byte stream behind a bounded, deterministic Interface.
/// Time and output publication stay outside this Module so tests can drive the
/// exact same implementation used by the sidecar runtime.
pub struct OutputBatcher {
    interval: Duration,
    max_batch_bytes: usize,
    pending: Vec<u8>,
    pending_since: Option<Instant>,
    next_seq: u64,
}

impl OutputBatcher {
    pub fn new(interval: Duration, max_batch_bytes: usize) -> Self {
        assert!(!interval.is_zero(), "batch interval must be positive");
        assert!(max_batch_bytes > 0, "batch byte bound must be positive");
        Self {
            interval,
            max_batch_bytes,
            pending: Vec::with_capacity(max_batch_bytes.min(64 * 1024)),
            pending_since: None,
            next_seq: 1,
        }
    }

    pub fn push(&mut self, mut data: &[u8], now: Instant) -> Vec<OutputBatch> {
        let mut batches = Vec::new();
        while !data.is_empty() {
            if self.pending.is_empty() {
                self.pending_since = Some(now);
            }
            let available = self.max_batch_bytes - self.pending.len();
            let take = available.min(data.len());
            self.pending.extend_from_slice(&data[..take]);
            data = &data[take..];
            if self.pending.len() == self.max_batch_bytes
                && let Some(batch) = self.flush()
            {
                batches.push(batch);
            }
        }
        if self.is_due(now)
            && let Some(batch) = self.flush()
        {
            batches.push(batch);
        }
        batches
    }

    pub fn flush_due(&mut self, now: Instant) -> Option<OutputBatch> {
        self.is_due(now).then(|| self.flush()).flatten()
    }

    pub fn flush(&mut self) -> Option<OutputBatch> {
        if self.pending.is_empty() {
            return None;
        }
        self.pending_since = None;
        let data = std::mem::replace(
            &mut self.pending,
            Vec::with_capacity(self.max_batch_bytes.min(64 * 1024)),
        );
        let seq = self.next_seq;
        self.next_seq += 1;
        Some(OutputBatch { seq, data })
    }

    pub fn deadline(&self) -> Option<Instant> {
        self.pending_since.map(|started| started + self.interval)
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    fn is_due(&self, now: Instant) -> bool {
        self.deadline().is_some_and(|deadline| now >= deadline)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coalesces_until_the_interval_and_sequences_flushes() {
        let start = Instant::now();
        let mut batcher = OutputBatcher::new(Duration::from_millis(16), 1024);

        assert!(batcher.push(b"one", start).is_empty());
        assert!(
            batcher
                .push(b"two", start + Duration::from_millis(15))
                .is_empty()
        );
        assert_eq!(
            batcher.flush_due(start + Duration::from_millis(16)),
            Some(OutputBatch {
                seq: 1,
                data: b"onetwo".to_vec(),
            })
        );

        batcher.push(b"three", start + Duration::from_millis(17));
        assert_eq!(batcher.flush().expect("second batch").seq, 2);
    }

    #[test]
    fn splits_large_input_at_the_byte_bound() {
        let start = Instant::now();
        let mut batcher = OutputBatcher::new(Duration::from_secs(1), 4);
        let batches = batcher.push(b"abcdefghij", start);

        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].data, b"abcd");
        assert_eq!(batches[1].data, b"efgh");
        assert_eq!(batcher.flush().expect("tail").data, b"ij");
    }
}
