const airWayElement = document.getElementById('airWayInput');
const seaLatElement = document.getElementById('seaLatInput');
const submit = document.getElementById('submit');
const form = document.getElementById('form');
const log = document.getElementById('log');
const METER_CONVERSION_FROM_FEET = 0.3048000;

form.addEventListener('submit', logSubmit);

let isAllowedToFly;

function logSubmit(event) {

  let result = (airWayElement.value * METER_CONVERSION_FROM_FEET) - seaLatElement.value - (200 * METER_CONVERSION_FROM_FEET)

  log.textContent = result.toFixed(2);
  isAllowedToFly = (result > 0 ) ? 'allowToFly' : 'notAllowToFly';
  log.className = isAllowedToFly

  event.preventDefault();
}


