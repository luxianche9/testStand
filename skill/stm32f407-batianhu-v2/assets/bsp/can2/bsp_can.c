#include "bsp_can.h"

CAN_HandleTypeDef Can_Handle;
CAN_RxHeaderTypeDef Can2_RxHeader;
uint8_t Can2_RxData[8];

static HAL_StatusTypeDef CAN_Filter_Config(void)
{
    CAN_FilterTypeDef filter = {0};

    /* Filter banks 14..27 belong to CAN2. Accept all frames into FIFO0. */
    filter.FilterBank = 14U;
    filter.FilterMode = CAN_FILTERMODE_IDMASK;
    filter.FilterScale = CAN_FILTERSCALE_32BIT;
    filter.FilterIdHigh = 0U;
    filter.FilterIdLow = 0U;
    filter.FilterMaskIdHigh = 0U;
    filter.FilterMaskIdLow = 0U;
    filter.FilterFIFOAssignment = CAN_FILTER_FIFO0;
    filter.FilterActivation = ENABLE;
    filter.SlaveStartFilterBank = 14U;
    return HAL_CAN_ConfigFilter(&Can_Handle, &filter);
}

HAL_StatusTypeDef BSP_CAN2_Init(void)
{
    GPIO_InitTypeDef gpio = {0};

    __HAL_RCC_GPIOB_CLK_ENABLE();
    /* CAN2 requires both CAN1 and CAN2 peripheral clocks. */
    __HAL_RCC_CAN1_CLK_ENABLE();
    __HAL_RCC_CAN2_CLK_ENABLE();

    gpio.Pin = CAN_RX_PIN | CAN_TX_PIN;
    gpio.Mode = GPIO_MODE_AF_PP;
    gpio.Pull = GPIO_NOPULL;
    gpio.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
    gpio.Alternate = CAN_AF_PORT;
    HAL_GPIO_Init(GPIOB, &gpio);

    Can_Handle.Instance = CAN2;
    Can_Handle.Init.Prescaler = 6U;
    Can_Handle.Init.Mode = CAN_MODE_NORMAL;
    Can_Handle.Init.SyncJumpWidth = CAN_SJW_1TQ;
    Can_Handle.Init.TimeSeg1 = CAN_BS1_3TQ;
    Can_Handle.Init.TimeSeg2 = CAN_BS2_3TQ;
    Can_Handle.Init.TimeTriggeredMode = DISABLE;
    Can_Handle.Init.AutoBusOff = ENABLE;
    Can_Handle.Init.AutoWakeUp = ENABLE;
    Can_Handle.Init.AutoRetransmission = ENABLE;
    Can_Handle.Init.ReceiveFifoLocked = DISABLE;
    Can_Handle.Init.TransmitFifoPriority = DISABLE;

    if (HAL_CAN_Init(&Can_Handle) != HAL_OK) {
        return HAL_ERROR;
    }
    if (CAN_Filter_Config() != HAL_OK) {
        return HAL_ERROR;
    }

    HAL_NVIC_SetPriority(CAN2_RX0_IRQn, 5U, 0U);
    HAL_NVIC_EnableIRQ(CAN2_RX0_IRQn);

    if (HAL_CAN_Start(&Can_Handle) != HAL_OK) {
        return HAL_ERROR;
    }
    return HAL_CAN_ActivateNotification(&Can_Handle,
                                        CAN_IT_RX_FIFO0_MSG_PENDING |
                                        CAN_IT_BUSOFF |
                                        CAN_IT_ERROR);
}

HAL_StatusTypeDef BSP_CAN2_Send(uint32_t extended_id,
                               const uint8_t *data,
                               uint8_t length,
                               uint32_t *mailbox)
{
    CAN_TxHeaderTypeDef header = {0};

    if ((data == NULL) || (mailbox == NULL) || (length > 8U)) {
        return HAL_ERROR;
    }

    header.ExtId = extended_id & 0x1FFFFFFFU;
    header.IDE = CAN_ID_EXT;
    header.RTR = CAN_RTR_DATA;
    header.DLC = length;
    header.TransmitGlobalTime = DISABLE;
    return HAL_CAN_AddTxMessage(&Can_Handle, &header, (uint8_t *)data, mailbox);
}

void CAN_Config(void)
{
    (void)BSP_CAN2_Init();
}

void Init_RxMes(void)
{
    uint32_t index;
    Can2_RxHeader.StdId = 0U;
    Can2_RxHeader.ExtId = 0U;
    Can2_RxHeader.IDE = CAN_ID_STD;
    Can2_RxHeader.RTR = CAN_RTR_DATA;
    Can2_RxHeader.DLC = 0U;
    for (index = 0U; index < sizeof(Can2_RxData); ++index) {
        Can2_RxData[index] = 0U;
    }
}

void CAN_SetMsg(void)
{
    uint8_t payload[8] = {0U, 1U, 2U, 3U, 4U, 5U, 6U, 7U};
    uint32_t mailbox;
    (void)BSP_CAN2_Send(0x1314U, payload, sizeof(payload), &mailbox);
}

void HAL_CAN_RxFifo0MsgPendingCallback(CAN_HandleTypeDef *hcan)
{
    if (hcan->Instance == CAN2) {
        (void)HAL_CAN_GetRxMessage(hcan, CAN_RX_FIFO0, &Can2_RxHeader, Can2_RxData);
    }
}

void CAN2_RX0_IRQHandler(void)
{
    HAL_CAN_IRQHandler(&Can_Handle);
}
