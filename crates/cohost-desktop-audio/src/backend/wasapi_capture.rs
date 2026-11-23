//! The Windows capture back end: WASAPI loopback of the default render device (EARS-SRC-014,
//! EARS-SRC-019). A change of the default render device is found by polling its id once a second.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use wasapi::{
    AudioCaptureClient, AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode,
    WaveFormat,
};

use crate::source::{Capture, DeviceEvent, Format, SourceChoice};

/// How long one read waits for a packet before it returns no samples.
const READ_WAIT: Duration = Duration::from_millis(100);
const POLL_DEFAULT: Duration = Duration::from_secs(1);

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn default_render_id() -> Result<String, String> {
    let enumerator = DeviceEnumerator::new().map_err(err)?;
    let device = enumerator
        .get_default_device(Direction::Render)
        .map_err(err)?;
    device.get_id().map_err(err)
}

pub struct WasapiCapture {
    client: Option<AudioClient>,
    capture: Option<AudioCaptureClient>,
    /// The mix format's sample type and bit depth.
    sample: Option<(SampleType, u16)>,
    device_id: Option<String>,
    queue: VecDeque<u8>,
    last_poll: Instant,
    /// Set after a read error, so the next event check polls at once.
    poll_now: bool,
}

impl WasapiCapture {
    pub fn new() -> Self {
        Self {
            client: None,
            capture: None,
            sample: None,
            device_id: None,
            queue: VecDeque::new(),
            last_poll: Instant::now(),
            poll_now: false,
        }
    }
}

impl Default for WasapiCapture {
    fn default() -> Self {
        Self::new()
    }
}

impl Capture for WasapiCapture {
    fn open(&mut self, choice: &SourceChoice) -> Result<Format, String> {
        if !matches!(choice, SourceChoice::DefaultRender) {
            return Err("the Windows helper captures the default render device".into());
        }
        self.close();
        wasapi::initialize_mta()
            .ok()
            .map_err(|e| format!("COM initialisation failed: {e}"))?;
        let enumerator = DeviceEnumerator::new().map_err(err)?;
        let device = enumerator
            .get_default_device(Direction::Render)
            .map_err(err)?;
        let id = device.get_id().map_err(err)?;
        let mut client = device.get_iaudioclient().map_err(err)?;
        let format: WaveFormat = client.get_mixformat().map_err(err)?;
        let sample_type = format.get_subformat().map_err(err)?;
        let bits = format.get_bitspersample();
        match (&sample_type, bits) {
            (SampleType::Float, 32) | (SampleType::Int, 16) => {}
            _ => {
                return Err(format!(
                    "unsupported mix format: {bits}-bit {sample_type:?}"
                ));
            }
        }
        // Loopback: a capture stream opened on a render device.
        client
            .initialize_client(
                &format,
                Direction::Capture,
                StreamMode::PollingShared {
                    autoconvert: true,
                    buffer_duration_hns: 1_000_000,
                },
                None,
            )
            .map_err(err)?;
        let capture = client.get_audiocaptureclient().map_err(err)?;
        client.start_stream().map_err(err)?;
        self.capture = Some(capture);
        self.client = Some(client);
        self.sample = Some((sample_type, bits));
        self.device_id = Some(id);
        self.last_poll = Instant::now();
        Ok(Format {
            rate: format.get_samplespersec(),
            channels: format.get_nchannels(),
        })
    }

    fn read(&mut self, out: &mut Vec<f32>) -> Result<(), String> {
        let result = self.read_packets(out);
        if result.is_err() {
            self.poll_now = true;
        }
        result
    }

    fn event(&mut self) -> Option<DeviceEvent> {
        if !self.poll_now && self.last_poll.elapsed() < POLL_DEFAULT {
            return None;
        }
        self.poll_now = false;
        self.last_poll = Instant::now();
        let opened = self.device_id.clone()?;
        match default_render_id() {
            Ok(now) if now != opened => Some(DeviceEvent::DefaultChanged),
            _ => None,
        }
    }
}

impl WasapiCapture {
    fn read_packets(&mut self, out: &mut Vec<f32>) -> Result<(), String> {
        let capture = self.capture.as_ref().ok_or("the capture is not open")?;
        let (sample_type, bits) = self.sample.as_ref().ok_or("the capture is not open")?;
        let deadline = Instant::now() + READ_WAIT;
        loop {
            if capture.get_next_packet_size().map_err(err)?.unwrap_or(0) > 0 {
                break;
            }
            if Instant::now() >= deadline {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        // The crate zero-fills buffers flagged silent, so their bytes are already silence.
        capture
            .read_from_device_to_deque(&mut self.queue)
            .map_err(err)?;
        let bytes: Vec<u8> = self.queue.drain(..).collect();
        match (sample_type, bits) {
            (SampleType::Float, _) => {
                let (frames, _) = bytes.as_chunks::<4>();
                out.extend(frames.iter().map(|b| f32::from_le_bytes(*b)));
            }
            _ => {
                let (frames, _) = bytes.as_chunks::<2>();
                out.extend(
                    frames
                        .iter()
                        .map(|b| f32::from(i16::from_le_bytes(*b)) / 32_768.0),
                );
            }
        }
        Ok(())
    }
}

impl WasapiCapture {
    fn close(&mut self) {
        if let Some(client) = self.client.take() {
            let _ = client.stop_stream();
        }
        self.capture = None;
        self.sample = None;
        self.device_id = None;
        self.queue.clear();
    }
}

impl Drop for WasapiCapture {
    fn drop(&mut self) {
        self.close();
    }
}
