const path = require('path');
const { override, addWebpackAlias, addWebpackResolve, addWebpackPlugin, addWebpackModuleRule } = require('customize-cra');
const webpack = require('webpack');

module.exports = override(
  // Add path alias for @ symbol
  addWebpackAlias({
    '@': path.resolve(__dirname, 'src')
  }),

  // Add polyfills and define global variables
  addWebpackPlugin(
    new webpack.ProvidePlugin({
      process: 'process/browser',
      Buffer: ['buffer', 'Buffer'],
    })
  ),

  addWebpackPlugin(
    new webpack.DefinePlugin({
      'process.env': JSON.stringify(process.env),
      global: 'globalThis',
    })
  ),

  // Configure fallbacks for Node.js modules
  (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      crypto: require.resolve('crypto-browserify'),
      stream: require.resolve('stream-browserify'),
      buffer: require.resolve('buffer'),
      process: require.resolve('process/browser'),
      path: require.resolve('path-browserify'),
      os: require.resolve('os-browserify/browser'),
      http: require.resolve('stream-http'),
      https: require.resolve('https-browserify'),
      zlib: require.resolve('browserify-zlib'),
    };

    // Ensure extensions are configured properly
    config.resolve.extensions = ['.ts', '.tsx', '.js', '.jsx', '.json'];

    return config;
  },

  // Handle WASM files if needed
  (config) => {
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };
    return config;
  }
);