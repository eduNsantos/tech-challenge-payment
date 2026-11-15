// Testes BDD da SAGA (Gherkin em português). Rodar: npm run test:bdd
module.exports = {
  default: {
    paths: ['features/**/*.feature'],
    require: ['features/support/**/*.js', 'features/step_definitions/**/*.js'],
    format: ['progress-bar', 'summary'],
    language: 'pt',
  },
};
