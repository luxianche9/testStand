#include "bsp_i2c_gpio.h"

static void I2C_Delay(void)
{
    volatile uint32_t count;
    for (count = 0U; count < 40U; ++count) {
        __NOP();
    }
}

static void SDA_Write(GPIO_PinState state)
{
    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_9, state);
}

static void SCL_Write(GPIO_PinState state)
{
    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_8, state);
}

void bsp_InitI2C(void)
{
    GPIO_InitTypeDef gpio = {0};

    __HAL_RCC_GPIOB_CLK_ENABLE();
    gpio.Pin = GPIO_PIN_8 | GPIO_PIN_9;
    gpio.Mode = GPIO_MODE_OUTPUT_OD;
    gpio.Pull = GPIO_PULLUP;
    gpio.Speed = GPIO_SPEED_FREQ_HIGH;
    HAL_GPIO_Init(GPIOB, &gpio);
    SDA_Write(GPIO_PIN_SET);
    SCL_Write(GPIO_PIN_SET);
}

void i2c_Start(void)
{
    SDA_Write(GPIO_PIN_SET);
    SCL_Write(GPIO_PIN_SET);
    I2C_Delay();
    SDA_Write(GPIO_PIN_RESET);
    I2C_Delay();
    SCL_Write(GPIO_PIN_RESET);
}

void i2c_Stop(void)
{
    SDA_Write(GPIO_PIN_RESET);
    SCL_Write(GPIO_PIN_SET);
    I2C_Delay();
    SDA_Write(GPIO_PIN_SET);
    I2C_Delay();
}

void i2c_SendByte(uint8_t value)
{
    uint8_t bit;
    for (bit = 0U; bit < 8U; ++bit) {
        SDA_Write((value & 0x80U) ? GPIO_PIN_SET : GPIO_PIN_RESET);
        I2C_Delay();
        SCL_Write(GPIO_PIN_SET);
        I2C_Delay();
        SCL_Write(GPIO_PIN_RESET);
        value <<= 1U;
    }
    SDA_Write(GPIO_PIN_SET);
}

uint8_t i2c_ReadByte(void)
{
    uint8_t bit;
    uint8_t value = 0U;
    SDA_Write(GPIO_PIN_SET);
    for (bit = 0U; bit < 8U; ++bit) {
        value <<= 1U;
        SCL_Write(GPIO_PIN_SET);
        I2C_Delay();
        if (HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_9) == GPIO_PIN_SET) {
            value |= 1U;
        }
        SCL_Write(GPIO_PIN_RESET);
        I2C_Delay();
    }
    return value;
}

uint8_t i2c_WaitAck(void)
{
    uint8_t no_ack;
    SDA_Write(GPIO_PIN_SET);
    I2C_Delay();
    SCL_Write(GPIO_PIN_SET);
    I2C_Delay();
    no_ack = (HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_9) == GPIO_PIN_SET) ? 1U : 0U;
    SCL_Write(GPIO_PIN_RESET);
    return no_ack;
}

void i2c_Ack(void)
{
    SDA_Write(GPIO_PIN_RESET);
    I2C_Delay();
    SCL_Write(GPIO_PIN_SET);
    I2C_Delay();
    SCL_Write(GPIO_PIN_RESET);
    SDA_Write(GPIO_PIN_SET);
}

void i2c_NAck(void)
{
    SDA_Write(GPIO_PIN_SET);
    I2C_Delay();
    SCL_Write(GPIO_PIN_SET);
    I2C_Delay();
    SCL_Write(GPIO_PIN_RESET);
}

uint8_t i2c_CheckDevice(uint8_t address)
{
    uint8_t no_ack;
    i2c_Start();
    i2c_SendByte(address | I2C_WR);
    no_ack = i2c_WaitAck();
    i2c_Stop();
    return no_ack;
}
