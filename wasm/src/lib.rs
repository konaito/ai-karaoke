#![no_std]

use core::panic::PanicInfo;

static mut LOWPASS_STATE: f32 = 0.0;

fn fast_sqrt(value: f32) -> f32 {
    if value <= 0.0 { return 0.0; }
    let mut guess = if value > 1.0 { value } else { 1.0 };
    for _ in 0..5 { guess = 0.5 * (guess + value / guess); }
    guess
}

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    loop {}
}

#[no_mangle]
pub extern "C" fn reset_filter() {
    unsafe { LOWPASS_STATE = 0.0; }
}

/// Keeps low-frequency centre content (kick/bass) while reducing the centred vocal.
/// `amount=0` is transparent and `amount=1` removes the high-passed centre completely.
#[no_mangle]
pub extern "C" fn vocal_reduce(
    left_ptr: *const f32,
    right_ptr: *const f32,
    out_left_ptr: *mut f32,
    out_right_ptr: *mut f32,
    len: usize,
    amount: f32,
    sample_rate: f32,
) {
    let left = unsafe { core::slice::from_raw_parts(left_ptr, len) };
    let right = unsafe { core::slice::from_raw_parts(right_ptr, len) };
    let out_left = unsafe { core::slice::from_raw_parts_mut(out_left_ptr, len) };
    let out_right = unsafe { core::slice::from_raw_parts_mut(out_right_ptr, len) };
    let cutoff = 160.0_f32;
    let dt = 1.0_f32 / sample_rate;
    let rc = 1.0_f32 / (core::f32::consts::TAU * cutoff);
    let alpha = dt / (rc + dt);
    let clamped_amount = if amount < 0.0 { 0.0 } else if amount > 1.0 { 1.0 } else { amount };
    let mut low = unsafe { LOWPASS_STATE };
    for i in 0..len {
        let mid = (left[i] + right[i]) * 0.5;
        low += alpha * (mid - low);
        let centre = low + (mid - low) * (1.0 - clamped_amount);
        let side = (left[i] - right[i]) * 0.5;
        out_left[i] = centre + side;
        out_right[i] = centre - side;
    }
    unsafe { LOWPASS_STATE = low; }
}

#[no_mangle]
pub extern "C" fn rms(ptr: *const f32, len: usize) -> f32 {
    let samples = unsafe { core::slice::from_raw_parts(ptr, len) };
    let mut sum = 0.0_f32;
    for sample in samples { sum += sample * sample; }
    fast_sqrt(sum / len as f32)
}

/// Autocorrelation pitch detector for a microphone block. Returns Hz, or 0 for unvoiced input.
#[no_mangle]
pub extern "C" fn detect_pitch(ptr: *const f32, len: usize, sample_rate: f32) -> f32 {
    let samples = unsafe { core::slice::from_raw_parts(ptr, len) };
    if len < 512 { return 0.0; }
    let level = rms(ptr, len);
    if level < 0.012 { return 0.0; }
    let mut mean = 0.0_f32;
    for sample in samples { mean += *sample; }
    mean /= len as f32;
    let min_lag = (sample_rate / 650.0) as usize;
    let max_lag = core::cmp::min((sample_rate / 75.0) as usize, len / 2);
    let mut best_lag = 0;
    let mut best = 0.0_f32;
    let mut lag = min_lag;
    while lag <= max_lag {
        let mut correlation = 0.0_f32;
        let mut energy_a = 0.0_f32;
        let mut energy_b = 0.0_f32;
        for i in 0..(len - lag) {
            let a = samples[i] - mean;
            let b = samples[i + lag] - mean;
            correlation += a * b;
            energy_a += a * a;
            energy_b += b * b;
        }
        let normalized = correlation / fast_sqrt(energy_a * energy_b).max(0.000001);
        if normalized > best { best = normalized; best_lag = lag; }
        lag += 1;
    }
    if best < 0.35 || best_lag == 0 { return 0.0; }
    sample_rate / best_lag as f32
}
