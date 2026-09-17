#ifndef BATIANHU_WM8978_RECORDER_CALLBACK_H
#define BATIANHU_WM8978_RECORDER_CALLBACK_H

/* Implement this callback in the application when I2S receive DMA is used. */
void Recorder_I2S_DMA_RX_Callback(void);
void MusicPlayer_I2S_DMA_TX_Callback(void);

#endif
