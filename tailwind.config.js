/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        primary: "#0D9488", // 👈 TEAL-600
        offwhite: "#F8FAFC", // 👈 New Off-White
      },
      fontFamily: {
        sans: ['Poppins-Regular', 'Cairo-Regular'], 
        bold: ['Poppins-Bold', 'Cairo-Bold'],
      },
    },
  },
  plugins: [],
};