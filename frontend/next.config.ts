import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  webpack: (config) => {
    // Fix for ONNX Runtime WASM files
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      path: false,
    };

    // Copy WASM files to static directory
    config.module.rules.push({
      test: /\.wasm$/,
      type: 'asset/resource',
    });

    // Suppress ONNX Runtime webpack warnings (non-critical)
    config.ignoreWarnings = [
      ...(config.ignoreWarnings || []),
      {
        module: /onnxruntime-web/,
        message: /Critical dependency: require function is used in a way/,
      },
    ];

    return config;
  },

  // Enable experimental features for WASM
  experimental: {
    // serverComponentsExternalPackages: ['onnxruntime-web'],
  },
};

export default nextConfig;
