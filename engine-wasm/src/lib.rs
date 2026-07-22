use rustfft::{num_complex::Complex64, Fft, FftPlanner};
use std::sync::Arc;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

#[wasm_bindgen]
pub fn logarithmic_kernel(r_squared: f64, epsilon: f64, reference_length: f64) -> f64 {
    -0.5 * ((r_squared + epsilon * epsilon) / (reference_length * reference_length)).ln()
}

#[wasm_bindgen]
pub fn pair_force(q_a: f64, q_b: f64, dx: f64, dy: f64, epsilon: f64) -> Vec<f64> {
    let scale = q_a * q_b / (dx * dx + dy * dy + epsilon * epsilon);
    vec![scale * dx, scale * dy]
}

#[wasm_bindgen]
pub fn spin_occupations(electrons: u32, multiplicity: u32, restricted: bool) -> Result<Vec<u32>, JsError> {
    if restricted {
        if electrons % 2 != 0 || multiplicity != 1 {
            return Err(JsError::new("RHF requires an even-electron singlet."));
        }
        return Ok(vec![electrons / 2, electrons / 2]);
    }
    let unpaired = multiplicity.checked_sub(1).ok_or_else(|| JsError::new("Multiplicity must be positive."))?;
    if unpaired > electrons || (electrons + unpaired) % 2 != 0 {
        return Err(JsError::new("Multiplicity is incompatible with the electron count."));
    }
    let alpha = (electrons + unpaired) / 2;
    Ok(vec![alpha, electrons - alpha])
}

#[wasm_bindgen]
pub struct ReferenceCore {
    field_size: usize,
    padded_size: usize,
    spacing: f64,
    fft_forward: Arc<dyn Fft<f64>>,
    fft_inverse: Arc<dyn Fft<f64>>,
    kernel_spectrum: Vec<Complex64>,
}

#[wasm_bindgen]
impl ReferenceCore {
    #[wasm_bindgen(constructor)]
    pub fn new(field_size: usize, spacing: f64, epsilon: f64, reference_length: f64) -> Result<ReferenceCore, JsError> {
        if field_size < 4 || !field_size.is_power_of_two() {
            return Err(JsError::new("The real-space grid must be a power of two and at least 4."));
        }
        if spacing <= 0.0 || epsilon <= 0.0 || reference_length <= 0.0 {
            return Err(JsError::new("Spacing, softening, and reference length must be positive."));
        }
        let padded_size = field_size * 2;
        let mut planner = FftPlanner::<f64>::new();
        let fft_forward = planner.plan_fft_forward(padded_size);
        let fft_inverse = planner.plan_fft_inverse(padded_size);
        let mut kernel = vec![Complex64::new(0.0, 0.0); padded_size * padded_size];
        for y in 0..padded_size {
            let sy = if y <= padded_size / 2 { y as isize } else { y as isize - padded_size as isize };
            for x in 0..padded_size {
                let sx = if x <= padded_size / 2 { x as isize } else { x as isize - padded_size as isize };
                let r2 = (sx as f64 * spacing).powi(2) + (sy as f64 * spacing).powi(2);
                kernel[y * padded_size + x].re = logarithmic_kernel(r2, epsilon, reference_length);
            }
        }
        fft_2d(&mut kernel, padded_size, &fft_forward);
        Ok(ReferenceCore { field_size, padded_size, spacing, fft_forward, fft_inverse, kernel_spectrum: kernel })
    }

    pub fn convolve(&self, field: &[f64]) -> Result<Vec<f64>, JsError> {
        self.check_field(field)?;
        let mut padded = self.embed(field);
        fft_2d(&mut padded, self.padded_size, &self.fft_forward);
        for (value, kernel) in padded.iter_mut().zip(self.kernel_spectrum.iter()) {
            *value *= kernel;
        }
        fft_2d(&mut padded, self.padded_size, &self.fft_inverse);
        let normalization = 1.0 / (self.padded_size * self.padded_size) as f64;
        Ok(self.extract(&padded, normalization * self.spacing * self.spacing))
    }

    pub fn precondition(&self, field: &[f64], shift: f64) -> Result<Vec<f64>, JsError> {
        self.check_field(field)?;
        if shift <= 0.0 { return Err(JsError::new("Preconditioner shift must be positive.")); }
        let mut padded = self.embed(field);
        fft_2d(&mut padded, self.padded_size, &self.fft_forward);
        let length = self.padded_size as f64 * self.spacing;
        for y in 0..self.padded_size {
            let sy = if y <= self.padded_size / 2 { y as isize } else { y as isize - self.padded_size as isize };
            let ky = 2.0 * std::f64::consts::PI * sy as f64 / length;
            for x in 0..self.padded_size {
                let sx = if x <= self.padded_size / 2 { x as isize } else { x as isize - self.padded_size as isize };
                let kx = 2.0 * std::f64::consts::PI * sx as f64 / length;
                padded[y * self.padded_size + x] /= shift + 0.5 * (kx * kx + ky * ky);
            }
        }
        fft_2d(&mut padded, self.padded_size, &self.fft_inverse);
        let normalization = 1.0 / (self.padded_size * self.padded_size) as f64;
        Ok(self.extract(&padded, normalization))
    }

    pub fn density(&self, orbitals: &[f64], orbital_count: usize) -> Result<Vec<f64>, JsError> {
        let points = self.field_size * self.field_size;
        if orbitals.len() != points * orbital_count {
            return Err(JsError::new("Flattened orbital buffer has the wrong length."));
        }
        let mut density = vec![0.0; points];
        for orbital in orbitals.chunks_exact(points) {
            for (rho, value) in density.iter_mut().zip(orbital.iter()) { *rho += value * value; }
        }
        Ok(density)
    }

    pub fn kinetic(&self, field: &[f64]) -> Result<Vec<f64>, JsError> {
        self.check_field(field)?;
        let n = self.field_size;
        let scale = -0.5 / (12.0 * self.spacing * self.spacing);
        let value = |x: isize, y: isize| -> f64 {
            if x < 0 || y < 0 || x >= n as isize || y >= n as isize { 0.0 } else { field[y as usize * n + x as usize] }
        };
        let mut result = vec![0.0; field.len()];
        for y in 0..n {
            for x in 0..n {
                let x = x as isize;
                let y = y as isize;
                let laplacian = -value(x + 2, y) + 16.0 * value(x + 1, y) - 30.0 * value(x, y) + 16.0 * value(x - 1, y) - value(x - 2, y)
                    - value(x, y + 2) + 16.0 * value(x, y + 1) - 30.0 * value(x, y) + 16.0 * value(x, y - 1) - value(x, y - 2);
                result[y as usize * n + x as usize] = scale * laplacian;
            }
        }
        Ok(result)
    }
}

impl ReferenceCore {
    fn check_field(&self, field: &[f64]) -> Result<(), JsError> {
        if field.len() != self.field_size * self.field_size {
            Err(JsError::new("Real-space field has the wrong length."))
        } else {
            Ok(())
        }
    }

    fn embed(&self, field: &[f64]) -> Vec<Complex64> {
        let mut padded = vec![Complex64::new(0.0, 0.0); self.padded_size * self.padded_size];
        for y in 0..self.field_size {
            for x in 0..self.field_size {
                padded[y * self.padded_size + x].re = field[y * self.field_size + x];
            }
        }
        padded
    }

    fn extract(&self, padded: &[Complex64], scale: f64) -> Vec<f64> {
        let mut result = vec![0.0; self.field_size * self.field_size];
        for y in 0..self.field_size {
            for x in 0..self.field_size {
                result[y * self.field_size + x] = padded[y * self.padded_size + x].re * scale;
            }
        }
        result
    }
}

fn fft_2d(data: &mut [Complex64], size: usize, fft: &Arc<dyn Fft<f64>>) {
    for row in data.chunks_exact_mut(size) { fft.process(row); }
    let mut column = vec![Complex64::new(0.0, 0.0); size];
    for x in 0..size {
        for y in 0..size { column[y] = data[y * size + x]; }
        fft.process(&mut column);
        for y in 0..size { data[y * size + x] = column[y]; }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn force_matches_energy_gradient_sign() {
        let force = pair_force(1.0, -1.0, 1.0, 0.0, 0.2);
        assert!(force[0] < 0.0);
        assert_eq!(force[1], 0.0);
    }

    #[test]
    fn convolution_preserves_constant_shapes() {
        let core = ReferenceCore::new(4, 0.5, 0.3, 1.0).unwrap();
        let mut field = vec![0.0; 16];
        field[5] = 1.0;
        let result = core.convolve(&field).unwrap();
        assert!(result.iter().all(|value| value.is_finite()));
        assert_eq!(result.len(), field.len());
    }

    #[test]
    fn fft_convolution_matches_direct_open_sum() {
        let n = 4;
        let spacing = 0.5;
        let epsilon = 0.3;
        let core = ReferenceCore::new(n, spacing, epsilon, 1.0).unwrap();
        let mut field = vec![0.0; n * n];
        field[5] = 0.7;
        field[11] = -0.2;
        let result = core.convolve(&field).unwrap();
        for y in 0..n {
            for x in 0..n {
                let mut expected = 0.0;
                for sy in 0..n {
                    for sx in 0..n {
                        let dx = (x as isize - sx as isize) as f64 * spacing;
                        let dy = (y as isize - sy as isize) as f64 * spacing;
                        expected += field[sy * n + sx] * logarithmic_kernel(dx * dx + dy * dy, epsilon, 1.0);
                    }
                }
                expected *= spacing * spacing;
                assert!((result[y * n + x] - expected).abs() < 1e-9);
            }
        }
    }
}
