#!/bin/sh
# led-booting.sh - sets the ACT LED to a distinctive blink pattern as early in boot as practical.

echo timer > /sys/class/leds/ACT/trigger
echo 300 > /sys/class/leds/ACT/delay_on
echo 300 > /sys/class/leds/ACT/delay_off
