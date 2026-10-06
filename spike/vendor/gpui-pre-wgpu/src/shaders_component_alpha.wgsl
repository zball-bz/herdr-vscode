// --- subpixel sprites without dual-source blending (WebGL2) --- //
//
// Concatenated after `shaders_webgl.wgsl`. A subpixel sprite is drawn twice:
// the coverage pass darkens the destination by each channel's coverage
// (blend: dst * (1 - src)), then the color pass adds the text color by the
// same coverage (blend: src + dst). Together they compute
// dst * (1 - coverage) + color * coverage per channel, as one draw with
// dual-source blending does. A subpixel sprite has a monochrome sprite's
// layout, so `vs_mono_sprite` places it.

fn subpixel_coverage(input: MonoSpriteVarying) -> vec3<f32> {
    var sample = textureSample(t_sprite, s_sprite, input.tile_position).rgb;
    if (gamma_params.is_bgr != 0u) {
        sample = sample.bgr;
    }
    let corrected = apply_contrast_and_gamma_correction3(sample, input.color.rgb, gamma_params.subpixel_enhanced_contrast, gamma_params.gamma_ratios);
    return corrected * input.color.a;
}

@fragment
fn fs_subpixel_sprite_coverage(input: MonoSpriteVarying) -> @location(0) vec4<f32> {
    let coverage = subpixel_coverage(input);
    // Alpha clip after using the derivatives.
    if (any(input.clip_distances < vec4<f32>(0.0))) {
        return vec4<f32>(0.0);
    }
    return vec4<f32>(coverage, 0.0);
}

@fragment
fn fs_subpixel_sprite_color(input: MonoSpriteVarying) -> @location(0) vec4<f32> {
    let coverage = subpixel_coverage(input);
    if (any(input.clip_distances < vec4<f32>(0.0))) {
        return vec4<f32>(0.0);
    }
    return vec4<f32>(input.color.rgb * coverage, 0.0);
}
